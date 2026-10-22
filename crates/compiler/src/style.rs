//! Validates authored style objects into immutable, ordered, target-independent definitions.
//!
//! This mirrors `Style.define`: names, declarations, and nested conditions keep JavaScript
//! own-property order, and token names resolve against the bound theme.

use std::borrow::Cow;
use std::sync::Arc;

use rustc_hash::FxHashMap;

use crate::data::{Data, Object, Property};
use crate::error::{Error, Result};
use crate::internal::binding;
use crate::internal::query::Metadata as Queries;
use crate::internal::theme::Definition as Theme;
use crate::internal::token::{self, Composition, CssOutput, Expression, Part, Reference};
use crate::internal::value::{self, Parsed};
use crate::internal::{condition, query, targets, typography, variable_sets};
use crate::js;

/// A declaration value.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    /// A compiler binding slot.
    Binding(Arc<binding::Reference>),
    /// An expression interpolating references.
    Expression(Arc<Expression>),
    /// A number.
    Number(f64),
    /// A string.
    String(Arc<str>),
    /// A token reference.
    Token(Arc<Reference>),
}

impl Value {
    /// Converts back into authored data.
    pub fn to_data(&self) -> Data {
        match self {
            Self::Binding(binding) => Data::Binding(Arc::clone(binding)),
            Self::Expression(expression) => Data::Expression(Arc::clone(expression)),
            Self::Number(number) => Data::Number(*number),
            Self::String(text) => Data::String(Arc::clone(text)),
            Self::Token(reference) => Data::Token(Arc::clone(reference)),
        }
    }

    /// Whether the value is an object rather than a primitive.
    pub fn is_object(&self) -> bool {
        !matches!(self, Self::Number(_) | Self::String(_))
    }
}

/// One ordered declaration.
#[derive(Clone, Debug, PartialEq)]
pub struct Declaration {
    /// Whether the declaration is `!important`.
    pub important: bool,
    /// camelCase property name or custom property.
    pub property: Arc<str>,
    /// Validated value.
    pub value: Value,
}

/// A nested block under an optional condition.
#[derive(Clone, Debug, PartialEq)]
pub struct Rule {
    /// Normalized condition: a selector containing `&` or an at-rule prelude.
    pub condition: Option<Arc<str>>,
    /// The block's declarations and nested rules.
    pub style: Arc<NamedStyle>,
}

/// Native and web branches applied after shared declarations.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Targets {
    /// Android declarations as static data.
    pub android: Option<Data>,
    /// iOS declarations as static data.
    pub ios: Option<Data>,
    /// Shared native declarations as static data.
    pub native: Option<Data>,
    /// Branch names in authored order, when known, for serializations that keep it.
    pub order: Vec<&'static str>,
    /// Web declarations with CSS semantics.
    pub web: Option<Arc<NamedStyle>>,
}

/// A named style definition.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NamedStyle {
    /// Composition mode inherited from the defining configuration.
    pub composition: Option<Composition>,
    /// CSS output inherited from the defining configuration.
    pub css_output: Option<CssOutput>,
    /// Declarations in authored order.
    pub declarations: Vec<Declaration>,
    /// Authored style name.
    pub name: Arc<str>,
    /// Nested blocks, present when the style contains conditions.
    pub rules: Option<Vec<Rule>>,
    /// Target branches.
    pub targets: Option<Targets>,
}

/// Readable CSS names for styles, keyed by style name.
pub type Labels = FxHashMap<Arc<str>, Label>;

/// A readable CSS name and optional configuration namespace.
#[derive(Clone, Debug, PartialEq)]
pub struct Label {
    /// Readable name.
    pub name: Arc<str>,
    /// Configuration namespace.
    pub namespace: Option<Arc<str>>,
}

/// Validated named styles in authored order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Definition {
    /// Readable CSS names retained for target compilation.
    pub labels: Option<Arc<Labels>>,
    /// Named styles.
    pub styles: Vec<Arc<NamedStyle>>,
}

/// A source span for diagnostics at an exact path.
#[derive(Clone, Debug, PartialEq)]
pub struct SourceLocation {
    /// Exclusive UTF-16 end offset.
    pub end: u32,
    /// Path components.
    pub path: Vec<Arc<str>>,
    /// Module identity.
    pub source: Arc<str>,
    /// Inclusive UTF-16 start offset.
    pub start: u32,
}

/// A validation failure category.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Code {
    /// The input structure cannot represent ordered declarations.
    InvalidStructure,
    /// A value is not accepted.
    InvalidValue,
}

impl Code {
    /// The TypeScript spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidStructure => "invalid_structure",
            Self::InvalidValue => "invalid_value",
        }
    }
}

/// A validation diagnostic.
#[derive(Clone, Debug, PartialEq)]
pub struct Diagnostic {
    /// Failure category.
    pub code: Code,
    /// Source span when one was supplied for the exact path.
    pub location: Option<SourceLocation>,
    /// Explanation.
    pub message: String,
    /// Path components.
    pub path: Vec<Arc<str>>,
}

/// Formats the message of `Style.InvalidError`.
pub fn error_message(diagnostics: &[Diagnostic]) -> String {
    diagnostics
        .iter()
        .map(|diagnostic| {
            let path = js::Value::Array(
                diagnostic
                    .path
                    .iter()
                    .map(|part| js::Value::from(&**part))
                    .collect(),
            );

            format!("{}: {}", js::stringify(&path), diagnostic.message)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The theme bound to a definition: a theme, or a variable set that binds as one.
#[derive(Clone, Copy, Debug)]
pub enum Vars<'a> {
    /// A theme with token-aware authoring.
    Theme(&'a Theme),
    /// A variable set, wrapped as a theme before resolution.
    Variables(&'a Theme),
}

/// Options for [`define`].
#[derive(Clone, Debug, Default)]
pub struct Options<'a> {
    /// Caller-owned source spans keyed by diagnostic path.
    pub locations: &'a [SourceLocation],
    /// Bound theme or variable set.
    pub vars: Option<Vars<'a>>,
}

struct Context<'a> {
    locations: Cow<'a, [SourceLocation]>,
    nesting: usize,
    target_branch: bool,
    theme: Option<&'a Theme>,
}

/// Validates named styles.
///
/// # Errors
///
/// Returns [`Error::Style`] with every diagnostic, in traversal order.
pub fn define(styles: &Data, options: &Options<'_>) -> Result<Definition> {
    let wrapped = match options.vars {
        Some(Vars::Variables(variables)) => Some(variable_sets::theme(variables, None)?),
        _ => None,
    };
    let theme = match options.vars {
        Some(Vars::Theme(theme)) => Some(theme),
        Some(Vars::Variables(_)) => wrapped.as_ref(),
        None => None,
    };
    let context = Context {
        locations: Cow::Borrowed(options.locations),
        nesting: 0,
        target_branch: false,
        theme,
    };

    define_with(styles, &context)
}

/// Validates top-level declarations of styles without a theme, as [`define`] validates them.
#[cfg(feature = "compiler")]
pub(crate) struct Declarer {
    validator: Validator<'static>,
}

#[cfg(feature = "compiler")]
impl Declarer {
    pub(crate) fn new() -> Self {
        Self {
            validator: Validator {
                diagnostics: Vec::new(),
                locations: &[],
                mapped: FxHashMap::default(),
                references: FxHashMap::default(),
            },
        }
    }

    /// Appends the declarations one property produces. Returns `false` when validation reports
    /// a diagnostic, which only [`define`] reports with its location.
    pub(crate) fn declare(
        &mut self,
        name: &Arc<str>,
        property: &Arc<str>,
        input: &Data,
        output: &mut Vec<Declaration>,
    ) -> bool {
        self.validator
            .declarations(name, property, input, property, None, output);
        self.validator.diagnostics.is_empty()
    }
}

fn define_with(styles: &Data, context: &Context<'_>) -> Result<Definition> {
    let theme = context.theme;

    if context.nesting > 128 {
        return Err(Error::Style(vec![Diagnostic {
            code: Code::InvalidStructure,
            location: None,
            message: "Nested styles exceed the depth limit.".to_owned(),
            path: Vec::new(),
        }]));
    }

    let mut validator = Validator {
        diagnostics: Vec::new(),
        locations: &context.locations,
        mapped: FxHashMap::default(),
        references: FxHashMap::default(),
    };
    let mut output: Vec<Arc<NamedStyle>> = Vec::new();

    for (name, style) in validator.entries(styles, &[]) {
        if name.is_empty() {
            validator.report(
                Code::InvalidStructure,
                &[Arc::clone(name)],
                "Style names must not be empty.",
            );
        }

        let mappings = theme.and_then(|theme| theme.metadata.contract.shorthands.as_ref());
        let authored: Vec<(&Arc<str>, &Data)> = validator
            .entries(style, &[Arc::clone(name)])
            .into_iter()
            .filter(|(key, value)| &***key != "targets" || !value.is_undefined())
            .collect();
        let target = authored
            .iter()
            .find(|(key, _)| &***key == "targets")
            .map(|(_, value)| *value);

        if let Some(target) = target {
            if context.target_branch {
                validator.report(
                    Code::InvalidStructure,
                    &[Arc::clone(name), "targets".into()],
                    "Target branches cannot contain nested target branches.",
                );
                continue;
            }

            let result = (|| -> std::result::Result<Arc<NamedStyle>, Error> {
                let mut branches = Targets::default();
                let target_path = [Arc::clone(name), Arc::from("targets")];

                for (key, input) in validator.entries(target, &target_path) {
                    // Target branches are rare, so they keep owned entries.
                    let (key, input) = (Arc::clone(key), input.clone());

                    if !matches!(&*key, "android" | "ios" | "native" | "web") {
                        validator.report(
                            Code::InvalidStructure,
                            &[Arc::clone(name), "targets".into(), Arc::clone(&key)],
                            "Unknown style target.",
                        );
                        continue;
                    }

                    if input.is_undefined() {
                        continue;
                    }

                    let branch = match &*key {
                        "android" => "android",
                        "ios" => "ios",
                        "native" => "native",
                        _ => "web",
                    };

                    if !branches.order.contains(&branch) {
                        branches.order.push(branch);
                    }

                    if &*key == "web" {
                        let nested = Context {
                            locations: Cow::Borrowed(&context.locations),
                            nesting: context.nesting + 1,
                            target_branch: true,
                            theme,
                        };

                        match define_with(
                            &Data::from(Object::from_entries([(Arc::clone(name), input)])),
                            &nested,
                        ) {
                            Ok(definition) => branches.web = definition.styles.into_iter().next(),
                            Err(Error::Style(diagnostics)) => {
                                for diagnostic in diagnostics {
                                    let mut path =
                                        vec![Arc::clone(name), "targets".into(), "web".into()];
                                    path.extend(diagnostic.path.into_iter().skip(1));
                                    validator.report(diagnostic.code, &path, &diagnostic.message);
                                }
                            }
                            Err(error) => return Err(error),
                        }
                    } else {
                        let path = [Arc::clone(name), Arc::from("targets"), Arc::clone(&key)];

                        validator.entries(&input, &path);

                        let copy = targets::copy(
                            &input,
                            &path
                                .iter()
                                .map(std::string::ToString::to_string)
                                .collect::<Vec<_>>(),
                            0,
                        )?;

                        match &*key {
                            "android" => branches.android = Some(copy),
                            "ios" => branches.ios = Some(copy),
                            _ => branches.native = Some(copy),
                        }
                    }
                }

                let shared = Object::from_entries(
                    authored
                        .iter()
                        .filter(|(key, _)| &***key != "targets")
                        .map(|(key, value)| (Arc::clone(key), (*value).clone())),
                );
                let nested = Context {
                    locations: Cow::Borrowed(&context.locations),
                    nesting: context.nesting + 1,
                    target_branch: context.target_branch,
                    theme,
                };
                let shared = define_with(
                    &Data::from(Object::from_entries([(
                        Arc::clone(name),
                        Data::from(shared),
                    )])),
                    &nested,
                )?
                .styles
                .into_iter()
                .next()
                .unwrap_or_default();

                Ok(Arc::new(NamedStyle {
                    targets: Some(branches),
                    ..(*shared).clone()
                }))
            })();

            match result {
                Ok(style) => output.push(style),
                Err(Error::Style(diagnostics)) => validator.diagnostics.extend(diagnostics),
                Err(error) => validator.report(
                    Code::InvalidStructure,
                    &[Arc::clone(name), "targets".into()],
                    &error.text(),
                ),
            }

            continue;
        }

        // Authored values stay borrowed; only typography presets add owned ones.
        let mut properties: Vec<(Arc<str>, Cow<'_, Data>, &Arc<str>)> =
            Vec::with_capacity(authored.len());

        for (property, input) in authored.iter().copied() {
            if &**property != "typography" {
                match mappings.and_then(|mappings| mappings.get(property)) {
                    Some(targets) => {
                        properties.extend(
                            targets
                                .iter()
                                .map(|target| (Arc::clone(target), Cow::Borrowed(input), property)),
                        );
                    }
                    None => {
                        properties.push((Arc::clone(property), Cow::Borrowed(input), property));
                    }
                }
                continue;
            }

            let parsed = value::parse(input, "fontFamily");

            if matches!(parsed, Some(Parsed::Invalid)) {
                validator.report(
                    Code::InvalidValue,
                    &[Arc::clone(name), Arc::clone(property)],
                    "Value markers require \" !custom\" followed by optional \" !important\", or \" !important\" alone.",
                );
                continue;
            }

            let (path, important) = match &parsed {
                Some(Parsed::Marked {
                    value, important, ..
                }) => (value.clone(), *important),
                _ => (input.clone(), false),
            };

            if typography::entries(theme, &path, &[], false).is_empty() {
                validator.report(
                    Code::InvalidValue,
                    &[Arc::clone(name), Arc::clone(property)],
                    "Expected a named typography set from the bound theme.",
                );
                continue;
            }

            // Explicit declarations in this block override the corresponding preset fields.
            let explicit: Vec<Arc<str>> = authored
                .iter()
                .flat_map(|(property, _)| {
                    match mappings.and_then(|mappings| mappings.get(*property)) {
                        Some(targets) => targets.to_vec(),
                        None => vec![Arc::clone(property)],
                    }
                })
                .collect();
            let explicit: Vec<&str> = explicit.iter().map(|property| &**property).collect();

            properties.extend(
                typography::entries(theme, &path, &explicit, important)
                    .into_iter()
                    .map(|(field, value)| (field, Cow::Owned(value), property)),
            );
        }

        if properties.iter().any(|(key, _, _)| condition::is(key)) {
            let mut rules: Vec<Rule> = Vec::new();
            let blocks: Vec<(Arc<str>, Data)> = authored
                .iter()
                .flat_map(|(key, input)| {
                    if &***key == "typography" {
                        properties
                            .iter()
                            .filter(|(_, _, original)| **original == **key)
                            .map(|(property, value, _)| {
                                (Arc::clone(property), value.clone().into_owned())
                            })
                            .collect::<Vec<_>>()
                    } else {
                        vec![(Arc::clone(key), (*input).clone())]
                    }
                })
                .collect();

            for (key, input) in blocks {
                let result = (|| -> Result<Rule> {
                    let resolved = if condition::is(&key) {
                        let empty = Queries::default();
                        let queries = theme
                            .and_then(|theme| theme.metadata.queries.as_deref())
                            .unwrap_or(&empty);

                        Some(query::resolve(&key, queries)?)
                    } else {
                        None
                    };

                    if let Some(resolved) = &resolved {
                        condition::normalize(resolved)?;
                    }

                    let locations: Vec<SourceLocation> = context
                        .locations
                        .iter()
                        .filter(|location| resolved.is_none() || location.path.get(1) == Some(&key))
                        .map(|location| {
                            if resolved.is_none() {
                                location.clone()
                            } else {
                                SourceLocation {
                                    path: location
                                        .path
                                        .iter()
                                        .enumerate()
                                        .filter(|(index, _)| *index != 1)
                                        .map(|(_, part)| Arc::clone(part))
                                        .collect(),
                                    ..location.clone()
                                }
                            }
                        })
                        .collect();
                    let body = match &resolved {
                        None => {
                            Data::from(Object::from_entries([(Arc::clone(&key), input.clone())]))
                        }
                        Some(_) => input.clone(),
                    };
                    let nested = Context {
                        locations: Cow::Owned(locations),
                        nesting: context.nesting + 1,
                        target_branch: context.target_branch,
                        theme,
                    };
                    let style = define_with(
                        &Data::from(Object::from_entries([(Arc::clone(name), body)])),
                        &nested,
                    )?
                    .styles
                    .into_iter()
                    .next()
                    .unwrap_or_default();
                    let condition = match resolved {
                        None => None,
                        Some(resolved) => {
                            let scoped =
                                if resolved.starts_with(':') && !condition::nested(&resolved) {
                                    format!("&{resolved}")
                                } else {
                                    resolved
                                };

                            Some(condition::normalize(&scoped)?.into())
                        }
                    };

                    Ok(Rule { condition, style })
                })();

                match result {
                    Ok(rule) => rules.push(rule),
                    Err(Error::Style(diagnostics)) => {
                        let conditional = condition::is(&key);

                        validator
                            .diagnostics
                            .extend(diagnostics.into_iter().map(|diagnostic| {
                                if !conditional {
                                    return diagnostic;
                                }

                                let rename = |path: &[Arc<str>]| {
                                    let mut next = vec![Arc::clone(name), Arc::clone(&key)];
                                    next.extend(path.iter().skip(1).cloned());
                                    next
                                };

                                Diagnostic {
                                    location: diagnostic.location.map(|location| SourceLocation {
                                        path: rename(&location.path),
                                        ..location
                                    }),
                                    path: rename(&diagnostic.path),
                                    ..diagnostic
                                }
                            }));
                    }
                    Err(error) => validator.report(
                        Code::InvalidStructure,
                        &[Arc::clone(name), Arc::clone(&key)],
                        &error.text(),
                    ),
                }
            }

            output.push(Arc::new(NamedStyle {
                name: Arc::clone(name),
                rules: Some(rules),
                ..NamedStyle::default()
            }));
            continue;
        }

        let mut declarations: Vec<Declaration> = Vec::with_capacity(properties.len());

        for (property, input, authored_property) in &properties {
            validator.declarations(
                name,
                property,
                input,
                authored_property,
                theme,
                &mut declarations,
            );
        }

        output.push(Arc::new(NamedStyle {
            declarations,
            name: Arc::clone(name),
            ..NamedStyle::default()
        }));
    }

    if !validator.diagnostics.is_empty() {
        return Err(Error::Style(validator.diagnostics));
    }

    let default_layer = theme.and_then(|theme| theme.metadata.contract.default_layer.clone());

    // Apply defaults after validation to retain authored diagnostic paths and explicit layer nesting.
    let styles = match default_layer {
        Some(layer) if context.nesting == 0 => {
            output.iter().map(|style| layered(style, &layer)).collect()
        }
        _ => output,
    };

    Ok(Definition {
        labels: None,
        styles,
    })
}

fn layered(style: &Arc<NamedStyle>, layer: &str) -> Arc<NamedStyle> {
    let body = NamedStyle {
        targets: None,
        ..(**style).clone()
    };
    let rules = match &style.rules {
        Some(rules) => rules
            .iter()
            .map(|rule| {
                let explicit = rule.condition.as_deref().is_some_and(|condition| {
                    condition == "@layer" || condition.starts_with("@layer ")
                });

                if explicit {
                    rule.clone()
                } else {
                    Rule {
                        style: layered(&rule.style, layer),
                        ..rule.clone()
                    }
                }
            })
            .collect(),
        None if style.declarations.is_empty() => Vec::new(),
        None => vec![Rule {
            condition: Some(format!("@layer {layer}").into()),
            style: Arc::new(body.clone()),
        }],
    };
    let targets = style.targets.as_ref().map(|targets| Targets {
        web: targets.web.as_ref().map(|web| layered(web, layer)),
        ..targets.clone()
    });

    Arc::new(NamedStyle {
        declarations: if style.rules.is_some() {
            style.declarations.clone()
        } else {
            Vec::new()
        },
        rules: Some(rules),
        targets,
        ..body
    })
}

struct Validator<'a> {
    diagnostics: Vec<Diagnostic>,
    locations: &'a [SourceLocation],
    /// Whether a theme maps tokens to a property, by theme address and property.
    mapped: FxHashMap<(usize, Arc<str>), bool>,
    /// The token or opacity expression a scalar resolves to, by theme address, property, and
    /// value text. Resolution scans every token path, so each value resolves once.
    references: FxHashMap<(usize, Arc<str>, String), Option<Data>>,
}

const MARKERS: &str = "Value markers require \" !custom\" followed by optional \" !important\", or \" !important\" alone.";

impl Validator<'_> {
    fn report(&mut self, code: Code, path: &[Arc<str>], message: &str) {
        let location = self
            .locations
            .iter()
            .find(|location| location.path.as_slice() == path)
            .cloned();

        self.diagnostics.push(Diagnostic {
            code,
            location,
            message: message.to_owned(),
            path: path.to_vec(),
        });
    }

    fn entries<'d>(&mut self, value: &'d Data, path: &[Arc<str>]) -> Vec<(&'d Arc<str>, &'d Data)> {
        let Data::Object(object) = value else {
            self.report(
                Code::InvalidStructure,
                path,
                "Expected a plain object with enumerable data properties.",
            );
            return Vec::new();
        };

        if object.exotic {
            self.report(
                Code::InvalidStructure,
                path,
                "Expected a plain object with enumerable data properties.",
            );
            return Vec::new();
        }

        let mut result = Vec::with_capacity(object.len());

        for (key, property) in object.properties() {
            match property {
                Property::Value(value) => result.push((key, value)),
                Property::Accessor => {
                    let mut next = path.to_vec();
                    next.push(Arc::clone(key));
                    self.report(
                        Code::InvalidStructure,
                        &next,
                        "Only enumerable string-keyed data properties are supported; accessors and symbols are not evaluated.",
                    );
                }
            }
        }

        result
    }

    fn declarations(
        &mut self,
        name: &Arc<str>,
        key: &Arc<str>,
        input: &Data,
        authored: &Arc<str>,
        theme: Option<&Theme>,
        output: &mut Vec<Declaration>,
    ) {
        // Diagnostics alone read the path, so valid declarations never build it.
        let path = || [Arc::clone(name), Arc::clone(authored)];
        let inputs: &[Data] = match input {
            Data::Array(items) => {
                if items.is_empty() {
                    self.report(
                        Code::InvalidValue,
                        &path(),
                        "Fallback arrays must be nonempty.",
                    );
                    return;
                }

                items
            }
            other => std::slice::from_ref(other),
        };

        for entry in inputs {
            if let Data::Object(object) = entry
                && matches!(object.get("variable"), Some(Data::Bool(true)))
            {
                self.report(
                    Code::InvalidStructure,
                    &path(),
                    "Invalid compiler binding reference.",
                );
                continue;
            }

            let parsed = value::parse(entry, key);

            if matches!(parsed, Some(Parsed::Invalid)) {
                self.report(Code::InvalidValue, &path(), MARKERS);
                continue;
            }

            let (custom, important, scalar) = match parsed {
                Some(Parsed::Marked {
                    custom,
                    important,
                    value,
                }) => (custom, important, Some(value)),
                _ => (false, false, None),
            };
            let had_markers = scalar.is_some();
            let scalar = scalar.unwrap_or_else(|| entry.clone());
            // Only an authored expression requires reference parts. Resolution returns opacity mixes.
            let authored_expression = matches!(scalar, Data::Expression(_));
            let resolved = match theme {
                Some(theme) if !custom && scalar.is_scalar() => {
                    let cache = (
                        std::ptr::from_ref(theme).addr(),
                        Arc::clone(key),
                        scalar.to_js_string(),
                    );

                    match self.references.get(&cache) {
                        Some(Some(resolved)) => resolved.clone(),
                        // A value no token names resolves to itself.
                        Some(None) => scalar,
                        None => {
                            let resolved = token::resolve(&scalar, key, theme);
                            let named = matches!(&resolved, Data::Token(_) | Data::Expression(_));

                            self.references
                                .insert(cache, named.then(|| resolved.clone()));
                            resolved
                        }
                    }
                }
                _ => scalar,
            };
            let reference = match &resolved {
                Data::Token(reference) => Some(reference),
                _ => None,
            };

            if let Some(reference) = reference
                && reference.contract.variable_set
                && !token::accepts_reference(reference, key)
            {
                self.report(
                    Code::InvalidValue,
                    &path(),
                    "Variable value is incompatible with this property.",
                );
                continue;
            }

            if let Some(theme) = theme
                && !custom
                && reference.is_none()
                && *self
                    .mapped
                    .entry((std::ptr::from_ref(theme).addr(), Arc::clone(key)))
                    .or_insert_with(|| token::mapped(theme, key))
                && !matches!(&resolved, Data::Binding(binding) if !binding.dynamic)
                && !matches!(&resolved, Data::Expression(expression) if !authored_expression || expression.parts.iter().all(|part| matches!(part, Part::Reference(_)) || matches!(part, Part::Text(text) if text.is_empty())))
            {
                self.report(
                    Code::InvalidValue,
                    &path(),
                    "Expected a configured token or a CSS value with the \" !custom\" suffix.",
                );
                continue;
            }

            let value = match resolved {
                Data::String(text) if had_markers && &*text == "0" => Value::Number(0.0),
                Data::String(text) => Value::String(text),
                Data::Number(number) => Value::Number(number),
                Data::Token(reference) => Value::Token(reference),
                Data::Expression(expression) => Value::Expression(expression),
                Data::Binding(binding) => Value::Binding(binding),
                other => {
                    // TypeScript accepts any value its types allow; other data reaches the compiler unchanged.
                    Value::String(other.to_js_string().into())
                }
            };

            output.push(Declaration {
                important,
                property: Arc::clone(key),
                value,
            });
        }
    }
}
