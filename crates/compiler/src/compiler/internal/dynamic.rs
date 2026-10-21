//! Reads dynamic style callbacks into typed runtime slots.

use std::sync::Arc;

use oxc_ast::ast::{
    Expression, ObjectExpression, PropertyKey, TSLiteral, TSSignature, TSType, UnaryOperator,
};
use oxc_span::GetSpan;
use rustc_hash::{FxHashMap, FxHashSet};

use crate::compiler::internal::expression::unwrap;
use crate::error::{Error, Result};
use crate::generated::cascade;
use crate::generated::literal::Kind;
use crate::internal::binding::{self, Domain};
use crate::internal::token::Part;
use crate::internal::{identity, literal};
use crate::js::Record;
use crate::style::{NamedStyle, Value};

/// Typed runtime slots by field name.
pub type Slots = Record<Arc<binding::Reference>>;

const RESERVED: [&str; 7] = [
    "class",
    "className",
    "key",
    "ref",
    "style",
    "vars",
    "__proto__",
];

/// A validated dynamic callback.
pub struct Read<'a> {
    /// The concise object body.
    pub body: &'a ObjectExpression<'a>,
    /// The concise body as an expression, without TypeScript wrappers.
    pub expression: &'a Expression<'a>,
    /// Fields whose declared type admits a CSS-wide keyword such as `inherit`.
    pub keywords: Vec<Arc<str>>,
    numeric: FxHashMap<Arc<str>, Vec<f64>>,
    parameter: &'a str,
    /// Slots by field name.
    pub slots: Slots,
    /// The parameter's authored type.
    pub type_annotation: &'a TSType<'a>,
}

fn invalid(message: &str, span: oxc_span::Span) -> Error {
    Error::Themes {
        message: message.to_owned(),
        span,
    }
}

/// Reads a dynamic callback `(values: Fields) => ({ ... })`, or `None` for other expressions.
///
/// `resolve_type` resolves type aliases and interfaces, as static evaluation does.
///
/// # Errors
///
/// Returns `Themes.InvalidError` for callbacks without one explicitly typed parameter, non-scalar
/// fields, reserved keys, and non-object bodies.
pub fn read<'a>(
    node: &'a Expression<'a>,
    identity: &str,
    resolve_type: &mut dyn FnMut(&'a TSType<'a>) -> Result<&'a TSType<'a>>,
) -> Result<Option<Read<'a>>> {
    let Expression::ArrowFunctionExpression(arrow) = unwrap(node) else {
        return Ok(None);
    };

    if arrow.r#async || arrow.params.items.len() + usize::from(arrow.params.rest.is_some()) != 1 {
        return Err(invalid(
            "Dynamic styles require one typed values parameter.",
            arrow.span,
        ));
    }

    let Some(parameter) = arrow.params.items.first() else {
        return Err(invalid(
            "Dynamic styles require one typed values parameter.",
            arrow.span,
        ));
    };
    let (Some(name), Some(annotation), None) = (
        parameter.pattern.get_binding_identifier(),
        parameter.type_annotation.as_ref(),
        parameter.initializer.as_ref(),
    ) else {
        return Err(invalid(
            "Dynamic styles require an explicit finite object type on the values parameter.",
            parameter.span,
        ));
    };

    if !matches!(
        parameter.pattern,
        oxc_ast::ast::BindingPattern::BindingIdentifier(_)
    ) {
        return Err(invalid(
            "Dynamic styles require an explicit finite object type on the values parameter.",
            parameter.span,
        ));
    }

    let TSType::TSTypeLiteral(fields) = resolve_type(&annotation.type_annotation)? else {
        return Err(invalid(
            "Dynamic styles require a finite object type.",
            parameter.span,
        ));
    };
    let mut slots = Slots::new();
    let mut numeric = FxHashMap::default();
    let mut keywords = Vec::new();

    for member in &fields.members {
        let TSSignature::TSPropertySignature(signature) = member else {
            return Err(invalid(
                "Dynamic values require unique required scalar fields without styling override keys.",
                member.span(),
            ));
        };
        let key = match &signature.key {
            PropertyKey::StaticIdentifier(identifier) => Some(identifier.name.to_string()),
            PropertyKey::StringLiteral(literal) => Some(literal.value.to_string()),
            _ => None,
        };
        let valid = !signature.computed
            && !signature.optional
            && signature.type_annotation.is_some()
            && key
                .as_deref()
                .is_some_and(|key| !RESERVED.contains(&key) && !slots.contains_key(key));
        let (true, Some(key), Some(field)) = (valid, key, signature.type_annotation.as_ref())
        else {
            return Err(invalid(
                "Dynamic values require unique required scalar fields without styling override keys.",
                signature.span,
            ));
        };
        let field = resolve_type(&field.type_annotation)?;
        let Some(kind) = scalar(field) else {
            return Err(invalid(
                "Dynamic values require explicit string or number scalar types.",
                signature.span,
            ));
        };
        let slot = Arc::new(binding::Reference {
            domain: if kind == ScalarKind::Number {
                Domain::Number
            } else {
                Domain::Length
            },
            dynamic: true,
            name: identity::slot(identity, &key),
            zero: kind == ScalarKind::ZeroString,
        });

        if let Some(values) = numbers(field) {
            numeric.insert(Arc::from(key.as_str()), values);
        }

        if kind != ScalarKind::Number && keyword(field) {
            keywords.push(Arc::from(key.as_str()));
        }

        slots.insert(key, slot);
    }

    let Some(expression @ Expression::ObjectExpression(body)) = arrow.get_expression().map(unwrap)
    else {
        let span = arrow
            .get_expression()
            .map_or(arrow.body.span(), GetSpan::span);

        return Err(invalid(
            "Dynamic styles require a concise static object body.",
            span,
        ));
    };

    Ok(Some(Read {
        body,
        expression,
        keywords,
        numeric,
        parameter: name.name.as_str(),
        slots,
        type_annotation: &annotation.type_annotation,
    }))
}

impl<'a> Read<'a> {
    /// Whether a numeric slot's declared values fit a property's literal rule.
    pub fn accepts(&self, reference: &binding::Reference, property: &str) -> bool {
        let field = self
            .slots
            .iter()
            .find(|(_, slot)| slot.name == reference.name)
            .map(|(field, _)| field);
        let (Some(values), Some(rule)) = (
            field.and_then(|field| self.numeric.get(field)),
            literal::rule(property),
        ) else {
            return false;
        };

        match rule.kind {
            Kind::GridLine => values
                .iter()
                .all(|value| is_safe_integer(*value) && *value != 0.0),
            // Native conversion rejects degenerate and negative ratios.
            Kind::Ratio => values.iter().all(|value| value.is_finite() && *value > 0.0),
            Kind::Number => values.iter().all(|value| {
                (rule.integer != Some(true) || is_safe_integer(*value))
                    && rule.min.is_none_or(|min| *value >= min)
                    && rule.max.is_none_or(|max| *value <= max)
            }),
            _ => false,
        }
    }

    /// Resolves `values.field` to its slot, or `None` for other expressions.
    ///
    /// # Errors
    ///
    /// Returns `Themes.InvalidError` for undeclared fields and optional reads.
    pub fn resolve(&self, node: &Expression<'a>) -> Result<Option<Arc<binding::Reference>>> {
        let node = unwrap(node);
        let (object, key, optional) = match node {
            Expression::StaticMemberExpression(member) => (
                &member.object,
                Some(member.property.name.to_string()),
                member.optional,
            ),
            Expression::ComputedMemberExpression(member) => (
                &member.object,
                match &member.expression {
                    Expression::StringLiteral(literal) => Some(literal.value.to_string()),
                    _ => None,
                },
                member.optional,
            ),
            Expression::PrivateFieldExpression(member) => (&member.object, None, member.optional),
            _ => return Ok(None),
        };

        if !matches!(object, Expression::Identifier(identifier) if identifier.name == self.parameter)
        {
            return Ok(None);
        }

        match key.and_then(|key| self.slots.get(&key).cloned()) {
            Some(slot) if !optional => Ok(Some(slot)),
            _ => Err(invalid(
                "Dynamic reads require declared scalar fields without optional access.",
                node.span(),
            )),
        }
    }
}

/// The properties that string fields fill directly, by field name.
///
/// A field qualifies when its only read is the whole value of one top-level declaration of a
/// style without conditions or web branches, and no later declaration of the style can affect
/// the same property. Writing such a value as an inline declaration then wins exactly where the
/// variable-backed declaration did. Other fields keep their variables.
///
/// A field in `keywords` stays on its variable: a CSS-wide keyword assigned to a custom property
/// applies to the property itself, not to the declaration that reads it.
pub fn inline<'s>(style: &'s NamedStyle, slots: &Slots, keywords: &[Arc<str>]) -> Record<&'s str> {
    let mut output = Record::new();

    if style.rules.is_some()
        || style
            .targets
            .as_ref()
            .is_some_and(|targets| targets.web.is_some())
    {
        return output;
    }

    let declarations = &style.declarations;
    let keywords: FxHashSet<&str> = keywords.iter().map(|field| &**field).collect();
    // Each binding's read count and first declaration, from one pass over the declarations.
    let mut reads: FxHashMap<&str, (usize, usize)> = FxHashMap::default();

    for (index, declaration) in declarations.iter().enumerate() {
        let mut read = |name: &'s str| {
            reads.entry(name).or_insert((0, index)).0 += 1;
        };

        match &declaration.value {
            Value::Binding(binding) => read(&binding.name),
            Value::Expression(expression) => {
                for part in &expression.parts {
                    if let Part::Binding(binding) = part {
                        read(&binding.name);
                    }
                }
            }
            _ => {}
        }
    }

    for (field, slot) in slots.iter() {
        if slot.domain != Domain::Length || slot.zero || keywords.contains(&**field) {
            continue;
        }

        let Some((1, index)) = reads.get(slot.name.as_str()).copied() else {
            continue;
        };
        let Some(declaration) = declarations.get(index) else {
            continue;
        };
        let property = &*declaration.property;

        if declaration.important
            || !matches!(declaration.value, Value::Binding(_))
            || !property.starts_with(|character: char| character.is_ascii_lowercase())
            || declarations
                .get(index + 1..)
                .unwrap_or_default()
                .iter()
                .any(|later| related(property, &later.property))
        {
            continue;
        }

        output.insert(Arc::clone(field), property);
    }

    output
}

/// Whether two declarations can set one computed property, conservatively by property family.
fn related(left: &str, right: &str) -> bool {
    let left = literal::alias(left).unwrap_or(left);
    let right = literal::alias(right).unwrap_or(right);
    // `all` resets every property except `direction` and `unicode-bidi`.
    left == right
        || left == "all"
        || right == "all"
        || family(left) == family(right)
        || expands(left, right)
        || expands(right, left)
        || (sizing(left) && sizing(right))
        || (inset(left) && inset(right))
}

/// The first camelCase word of a property, which longhands of one shorthand usually share.
fn family(property: &str) -> &str {
    property
        .split(|character: char| character.is_ascii_uppercase())
        .next()
        .unwrap_or(property)
}

/// Whether a shorthand resets a property, directly or through nested shorthands.
fn expands(shorthand: &str, property: &str) -> bool {
    cascade::shorthand(shorthand).is_some_and(|children| {
        children
            .iter()
            .any(|child| *child == property || expands(child, property))
    })
}

/// Physical and logical inset properties share computed values.
fn inset(property: &str) -> bool {
    property.starts_with("inset") || matches!(property, "bottom" | "left" | "right" | "top")
}

/// Physical and logical sizes share computed values.
fn sizing(property: &str) -> bool {
    let property = property
        .strip_prefix("min")
        .or_else(|| property.strip_prefix("max"))
        .unwrap_or(property);

    matches!(
        property,
        "blockSize"
            | "BlockSize"
            | "height"
            | "Height"
            | "inlineSize"
            | "InlineSize"
            | "width"
            | "Width"
    )
}

/// Whether a string type admits a CSS-wide keyword, which CSS matches after trimming whitespace.
/// String literals are already checked, and unresolved references count as unconstrained.
fn keyword(node: &TSType<'_>) -> bool {
    match node {
        TSType::TSLiteralType(_) | TSType::TSNumberKeyword(_) => false,
        TSType::TSTemplateLiteralType(template) => {
            template.quasis.iter().all(|part| {
                part.value.raw.bytes().all(|byte| {
                    byte.is_ascii_alphabetic() || byte.is_ascii_whitespace() || byte == b'-'
                })
            }) && (template.types.is_empty() || template.types.iter().any(hole))
        }
        TSType::TSIntersectionType(intersection) => intersection.types.iter().all(keyword),
        TSType::TSUnionType(union) => union.types.iter().any(keyword),
        _ => true,
    }
}

/// Whether a template hole can supply letters, as string literals and unconstrained types can.
fn hole(node: &TSType<'_>) -> bool {
    match node {
        TSType::TSNumberKeyword(_) => false,
        TSType::TSLiteralType(literal) => !matches!(
            literal.literal,
            TSLiteral::NumericLiteral(_) | TSLiteral::UnaryExpression(_)
        ),
        TSType::TSUnionType(union) => union.types.iter().any(hole),
        _ => true,
    }
}

fn is_safe_integer(value: f64) -> bool {
    value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ScalarKind {
    Number,
    String,
    ZeroString,
}

const GLOBAL_KEYWORDS: [&str; 5] = ["initial", "inherit", "unset", "revert", "revert-layer"];

fn scalar(node: &TSType<'_>) -> Option<ScalarKind> {
    match node {
        TSType::TSIntersectionType(intersection) => {
            let kinds: Vec<Option<ScalarKind>> = intersection.types.iter().map(scalar).collect();
            let first = *kinds.first()?;

            kinds
                .iter()
                .all(|kind| *kind == first)
                .then_some(first)
                .flatten()
        }
        TSType::TSNumberKeyword(_) => Some(ScalarKind::Number),
        TSType::TSStringKeyword(_) => Some(ScalarKind::String),
        TSType::TSTemplateLiteralType(template) => {
            (template.types.iter().all(|kind| scalar(kind).is_some())
                && template
                    .quasis
                    .iter()
                    .all(|part| !part.value.raw.contains('!')))
            .then_some(ScalarKind::String)
        }
        TSType::TSLiteralType(literal) => {
            if numbers(node).is_some() {
                return Some(ScalarKind::Number);
            }

            match &literal.literal {
                TSLiteral::NumericLiteral(_) => Some(ScalarKind::Number),
                TSLiteral::StringLiteral(text)
                    if !text.value.contains('!')
                        && !GLOBAL_KEYWORDS
                            .contains(&crate::js::trim(&text.value).to_lowercase().as_str()) =>
                {
                    Some(ScalarKind::String)
                }
                _ => None,
            }
        }
        TSType::TSUnionType(union) => {
            let kinds: Vec<Option<ScalarKind>> = union.types.iter().map(scalar).collect();
            let stringy = |kind: &Option<ScalarKind>| {
                matches!(kind, Some(ScalarKind::String | ScalarKind::ZeroString))
            };

            if kinds.iter().any(stringy)
                && union.types.iter().zip(&kinds).all(|(member, kind)| {
                    stringy(kind)
                        || numbers(member)
                            .is_some_and(|values| values.iter().all(|value| *value == 0.0))
                })
            {
                return Some(ScalarKind::ZeroString);
            }

            let first = *kinds.first()?;

            kinds
                .iter()
                .all(|kind| *kind == first)
                .then_some(first)
                .flatten()
        }
        _ => None,
    }
}

fn numbers(node: &TSType<'_>) -> Option<Vec<f64>> {
    match node {
        TSType::TSIntersectionType(intersection) => {
            let domains: Vec<Option<Vec<f64>>> = intersection
                .types
                .iter()
                .filter(|kind| !matches!(kind, TSType::TSNumberKeyword(_)))
                .map(numbers)
                .collect();

            if domains.is_empty() || domains.iter().any(Option::is_none) {
                return None;
            }

            let domains: Vec<Vec<f64>> = domains.into_iter().flatten().collect();
            let first = domains.first()?;

            Some(
                first
                    .iter()
                    .copied()
                    .filter(|value| domains.iter().all(|domain| domain.contains(value)))
                    .collect(),
            )
        }
        TSType::TSUnionType(union) => {
            let members: Vec<Option<Vec<f64>>> = union.types.iter().map(numbers).collect();

            members
                .iter()
                .all(Option::is_some)
                .then(|| members.into_iter().flatten().flatten().collect())
        }
        TSType::TSLiteralType(literal) => match &literal.literal {
            TSLiteral::NumericLiteral(number) => Some(vec![number.value]),
            TSLiteral::UnaryExpression(unary) if unary.operator == UnaryOperator::UnaryNegation => {
                match &unary.argument {
                    Expression::NumericLiteral(number) => Some(vec![-number.value]),
                    _ => None,
                }
            }
            _ => None,
        },
        _ => None,
    }
}
