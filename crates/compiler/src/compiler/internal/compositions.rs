//! Resolves known applications into ordered compiler-owned composition groups.
//!
//! Composition reads `cx(...)` arguments as a single forward walk resolves them, without
//! evaluating expressions or changing binding reads.

use std::borrow::Cow;
use std::sync::Arc;

use indexmap::IndexMap;
use oxc_allocator::{Allocator, CloneIn, Vec as ArenaVec};
use oxc_ast::AstKind;
use oxc_ast::ast::{
    Argument, BindingPattern, CallExpression, Expression, ImportDeclarationSpecifier,
    ImportOrExportKind, LogicalOperator, ObjectExpression, ObjectPropertyKind, Program,
    PropertyKey, Statement, UnaryOperator, VariableDeclarationKind,
};
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::Visit;
use oxc_semantic::Semantic;
use oxc_span::{GetSpan, Span};
use oxc_syntax::symbol::SymbolId;
use rustc_hash::{FxBuildHasher, FxHashMap, FxHashSet};

use crate::compiler::internal::applications::{self, Application};
use crate::compiler::internal::composition_bindings::{self, Bindings};
use crate::compiler::internal::expression::unwrap;
use crate::compiler::internal::recipes;
use crate::compiler::internal::scope::{self, Kind, Mode};
use crate::compiler::internal::statics::key_literal;
use crate::compiler::internal::themes::{Link, Output, ScopeApplication};
use crate::compiler::source::{Call, KnownInput, RuntimeInput};
use crate::error::{Error, Result};
use crate::internal::identity;
use crate::internal::token::{Composition, CssOutput};
use crate::js::{self, Record, Utf16Index};
use crate::runtime::composition::Owner;
use crate::style::{Declaration, NamedStyle, Rule};

/// Static composition extraction inputs.
#[derive(Clone, Copy)]
pub struct Options<'o, 'a> {
    /// Arena for synthesized bodies.
    pub allocator: &'a Allocator,
    /// Extracted authoring calls.
    pub calls: &'o [Call<'a>],
    /// Stable module identity.
    pub identity: &'o str,
    /// Imported style definitions the source graph supplies, by local name.
    pub links: Option<&'o Record<Link>>,
    /// UTF-16 offsets, for names that embed source positions.
    pub offsets: &'o Utf16Index,
    /// The parsed module.
    pub program: &'a Program<'a>,
    /// Validated variable scope applications, by start.
    pub scopes: Option<&'o IndexMap<u32, ScopeApplication, FxBuildHasher>>,
    /// Scopes and symbols of the module.
    pub semantic: &'o Semantic<'a>,
    /// Module source, for initialization-sensitive binding reads.
    pub source: &'a str,
    /// Validated ordered styles.
    pub styles: &'o [Arc<NamedStyle>],
}

/// One composition and its precompiled presence alternatives.
pub struct Entry<'a> {
    /// The composed call.
    pub call: Call<'a>,
    /// Presence alternatives for conditional arguments, in bitmask order.
    pub cases: Vec<(Call<'a>, Arc<NamedStyle>)>,
    /// The composed style.
    pub style: Arc<NamedStyle>,
}

fn invalid(message: &str, span: Span) -> Error {
    Error::Themes {
        message: message.to_owned(),
        span,
    }
}

/// Whether a non-type import from `zyzz` names `cx`.
fn imports_cx(program: &Program<'_>) -> bool {
    program.body.iter().any(|statement| {
        let Statement::ImportDeclaration(import) = statement else {
            return false;
        };

        import.source.value == "zyzz"
            && import.import_kind != ImportOrExportKind::Type
            && import.specifiers.iter().flatten().any(|specifier| {
                matches!(specifier, ImportDeclarationSpecifier::ImportSpecifier(specifier)
                    if specifier.imported.name() == "cx")
            })
    })
}

struct Walker<'o, 'a> {
    aliases: FxHashMap<SymbolId, &'o Link>,
    ancestors: Vec<AstKind<'a>>,
    bodies: FxHashMap<u32, &'a ObjectExpression<'a>>,
    calls: FxHashMap<u32, &'o Call<'a>>,
    /// Applications of imported styles, by call.
    external_applications: Vec<Application>,
    /// The last call of each imported style, with its renamed style.
    externals: Vec<(Call<'a>, Arc<NamedStyle>)>,
    links: Option<&'o Record<Link>>,
    nodes: Vec<&'a CallExpression<'a>>,
    semantic: &'o Semantic<'a>,
    undefined_reads: FxHashSet<u32>,
}

impl<'o, 'a> Walker<'o, 'a> {
    fn declaration(&self, node: &Expression<'a>) -> Option<scope::Declaration<'a>> {
        let Expression::Identifier(identifier) = node else {
            return None;
        };
        let scope = scope::scope_of(self.semantic, identifier.node_id());

        scope::lookup_before(
            self.semantic,
            &identifier.name,
            scope,
            identifier.span.start,
            Mode::Value,
        )
    }

    fn external(&self, node: &Expression<'a>) -> Option<&'o Link> {
        match node {
            Expression::Identifier(identifier) => {
                let binding = self.declaration(node)?;

                if let Some(alias) = self.aliases.get(&binding.symbol) {
                    return Some(alias);
                }

                let import = binding
                    .import
                    .filter(|import| import.import_kind != ImportOrExportKind::Type);

                (binding.kind == Kind::Import && import.is_some())
                    .then(|| self.links.and_then(|links| links.get(&identifier.name)))
                    .flatten()
            }
            Expression::StaticMemberExpression(member) if !member.optional => self
                .external(&member.object)?
                .members
                .as_ref()?
                .get(&member.property.name),
            _ => None,
        }
    }

    /// Whether a callee names the `cx` import from `zyzz`.
    fn is_cx(&self, callee: &Expression<'a>) -> bool {
        let Some(binding) = self.declaration(callee) else {
            return false;
        };
        let Some(import) = binding.import.filter(|import| {
            binding.kind == Kind::Import
                && import.source.value == "zyzz"
                && import.import_kind != ImportOrExportKind::Type
        }) else {
            return false;
        };

        import.specifiers.iter().flatten().any(|specifier| {
            matches!(specifier, ImportDeclarationSpecifier::ImportSpecifier(specifier)
                if specifier.span == binding.span
                    && specifier.import_kind != ImportOrExportKind::Type
                    && specifier.imported.name() == "cx")
        })
    }
}

impl<'a> Visit<'a> for Walker<'_, 'a> {
    fn enter_node(&mut self, kind: AstKind<'a>) {
        let parent = self.ancestors.last().copied();

        self.ancestors.push(kind);

        match kind {
            AstKind::VariableDeclarator(declarator) => {
                let constant = matches!(parent, Some(AstKind::VariableDeclaration(variable)) if variable.kind == VariableDeclarationKind::Const);
                let (true, Some(init)) = (constant, &declarator.init) else {
                    return;
                };
                let Some(link) = self.external(init) else {
                    return;
                };

                match &declarator.id {
                    BindingPattern::BindingIdentifier(identifier) => {
                        if let Some(symbol) = identifier.symbol_id.get() {
                            self.aliases.insert(symbol, link);
                        }
                    }
                    BindingPattern::ObjectPattern(pattern) => {
                        for property in &pattern.properties {
                            let (
                                false,
                                PropertyKey::StaticIdentifier(key),
                                BindingPattern::BindingIdentifier(value),
                            ) = (property.computed, &property.key, &property.value)
                            else {
                                continue;
                            };

                            if let (Some(member), Some(symbol)) = (
                                link.members
                                    .as_ref()
                                    .and_then(|members| members.get(&key.name)),
                                value.symbol_id.get(),
                            ) {
                                self.aliases.insert(symbol, member);
                            }
                        }
                    }
                    _ => {}
                }
            }
            AstKind::CallExpression(node) => {
                if let Some(link) = self.external(&node.callee)
                    && let Some(style) = link.style.as_ref().filter(|_| !node.optional)
                {
                    let name = Arc::clone(&link.binding);
                    let call = Call {
                        identity: Some(Arc::clone(&name)),
                        name: Arc::clone(&name),
                        output: style.output,
                        ownership: Some(Owner {
                            attributes: style.attributes.clone(),
                            identity: Arc::clone(&name),
                            identity_first: false,
                            slots: style.slots.clone(),
                        }),
                        portable: style.class_name.clone(),
                        start: node.span.start,
                        ..Call::default()
                    };
                    let renamed = NamedStyle {
                        name: Arc::clone(&name),
                        ..(*style.style).clone()
                    };
                    let application = Application {
                        callee_end: node.callee.span().end,
                        class_override: None,
                        class_read: None,
                        end: node.span.end,
                        initialized: true,
                        name: Arc::clone(&name),
                        spread: None,
                        start: node.span.start,
                        terminal: false,
                    };
                    let style = Arc::new(renamed);

                    match self
                        .externals
                        .iter_mut()
                        .find(|(call, _)| call.name == name)
                    {
                        Some(entry) => *entry = (call, style),
                        None => self.externals.push((call, style)),
                    }

                    self.external_applications.push(application);
                }

                if let Some(call) = self.calls.get(&node.span.start) {
                    let argument = node.arguments.first().and_then(Argument::as_expression);
                    let body = call.body.or_else(|| match argument {
                        Some(Expression::ArrowFunctionExpression(arrow)) => {
                            match arrow.get_expression().map(unwrap) {
                                Some(Expression::ObjectExpression(body)) => Some(&**body),
                                _ => None,
                            }
                        }
                        Some(Expression::ObjectExpression(body)) => Some(&**body),
                        _ => None,
                    });

                    if let Some(body) = body {
                        self.bodies.insert(call.start, body);
                    }
                }

                if matches!(node.callee, Expression::Identifier(_)) && self.is_cx(&node.callee) {
                    self.nodes.push(node);
                }
            }
            AstKind::IdentifierReference(identifier) if identifier.name == "undefined" => {
                let scope = scope::scope_of(self.semantic, identifier.node_id());

                if scope::lookup_before(
                    self.semantic,
                    "undefined",
                    scope,
                    identifier.span.start,
                    Mode::Value,
                )
                .is_none()
                {
                    self.undefined_reads.insert(identifier.span.start);
                }
            }
            _ => {}
        }
    }

    fn leave_node(&mut self, _: AstKind<'a>) {
        self.ancestors.pop();
    }
}

/// Whether an argument value is omitted: an unbound `undefined`, `false`, `null`, or `void`.
fn omitted(value: &Expression<'_>, undefined_reads: &FxHashSet<u32>) -> bool {
    undefined_reads.contains(&value.span().start)
        || matches!(value, Expression::BooleanLiteral(literal) if !literal.value)
        || matches!(value, Expression::NullLiteral(_))
        || matches!(value, Expression::UnaryExpression(unary)
            if unary.operator == UnaryOperator::Void && is_literal(&unary.argument))
}

fn is_literal(node: &Expression<'_>) -> bool {
    matches!(
        node,
        Expression::StringLiteral(_)
            | Expression::NumericLiteral(_)
            | Expression::BooleanLiteral(_)
            | Expression::NullLiteral(_)
            | Expression::BigIntLiteral(_)
            | Expression::RegExpLiteral(_)
    )
}

fn owners(call: &Call<'_>) -> Vec<Owner> {
    if let Some(ownership) = &call.ownership {
        return vec![ownership.clone()];
    }

    if let Some(inputs) = &call.runtime_composition {
        return inputs
            .iter()
            .flat_map(|input| input.owners.iter().cloned())
            .collect();
    }

    let conditions = call
        .recipe
        .as_ref()
        .and_then(|recipe| recipe.conditions.as_ref())
        .map_or(0, Vec::len);
    let attributes = call
        .recipe
        .iter()
        .flat_map(|recipe| recipe.axes.keys())
        .flat_map(|axis| {
            std::iter::once(Arc::from(format!("data-{axis}")))
                .chain(
                    (0..conditions)
                        .map(move |condition| Arc::from(recipes::attribute(axis, condition))),
                )
                .collect::<Vec<Arc<str>>>()
        });
    let slots = call
        .slots
        .iter()
        .flat_map(|slots| slots.values().map(|slot| Arc::from(slot.name.as_str())))
        .chain(call.recipe.iter().flat_map(|recipe| {
            recipe.payloads.iter().flatten().flat_map(|payload| {
                payload
                    .slots
                    .iter()
                    .flat_map(|slots| slots.values().cloned())
            })
        }));

    vec![Owner {
        identity_first: true,
        attributes: attributes.collect(),
        identity: Arc::clone(&call.name),
        slots: slots.collect(),
    }]
}

/// Lists declarations in emitted order, through conditions and segments.
fn declarations(style: &NamedStyle) -> Vec<&Declaration> {
    match &style.rules {
        Some(rules) => rules
            .iter()
            .flat_map(|rule| declarations(&rule.style))
            .collect(),
        None => style.declarations.iter().collect(),
    }
}

/// Rules that apply each selected style in order, inheriting its CSS output.
fn rules(selected: &[Call<'_>], styles: &FxHashMap<Arc<str>, Arc<NamedStyle>>) -> Vec<Rule> {
    selected
        .iter()
        .filter_map(|call| styles.get(&call.name))
        .flat_map(|style| match &style.rules {
            Some(rules) => rules
                .iter()
                .map(|rule| Rule {
                    condition: rule.condition.clone(),
                    style: if rule.style.css_output.is_some() || style.css_output.is_none() {
                        Arc::clone(&rule.style)
                    } else {
                        Arc::new(NamedStyle {
                            css_output: style.css_output,
                            ..(*rule.style).clone()
                        })
                    },
                })
                .collect::<Vec<_>>(),
            None => vec![Rule {
                condition: None,
                style: Arc::clone(style),
            }],
        })
        .collect()
}

/// A composition of independent styles keeps their sharing contract.
fn independent(
    selected: &[Call<'_>],
    styles: &FxHashMap<Arc<str>, Arc<NamedStyle>>,
) -> Option<Composition> {
    selected
        .iter()
        .all(|call| {
            styles
                .get(&call.name)
                .is_some_and(|style| style.composition == Some(Composition::Independent))
        })
        .then_some(Composition::Independent)
}

fn portable(selected: &[&Call<'_>]) -> Option<(Arc<str>, Vec<Arc<str>>)> {
    let mut inputs: Vec<Arc<str>> = Vec::new();

    for call in selected {
        let portable = call.portable.as_ref()?;

        match &call.portable_inputs {
            Some(nested) => inputs.extend(nested.iter().cloned()),
            None => inputs.push(Arc::clone(portable)),
        }
    }

    let names: Vec<&str> = inputs.iter().map(|input| &**input).collect();

    Some((Arc::from(identity::composition(&names)), inputs))
}

fn typography(selected: &[&Call<'_>], queries: bool) -> FxHashMap<u32, u32> {
    selected
        .iter()
        .flat_map(|call| {
            if queries {
                call.typography_queries.iter()
            } else {
                call.typography.iter()
            }
        })
        .flat_map(|map| map.iter().map(|(start, count)| (*start, *count)))
        .collect()
}

struct Synthesizer<'o, 'a> {
    allocator: &'a Allocator,
    ast: AstBuilder<'a>,
    bodies: &'o FxHashMap<u32, &'a ObjectExpression<'a>>,
    styles: &'o FxHashMap<Arc<str>, Arc<NamedStyle>>,
}

impl<'a> Synthesizer<'_, 'a> {
    fn literal(&self, value: &str) -> (&'a str, &'a str) {
        (
            self.allocator.alloc_str(value),
            self.allocator.alloc_str(&js::quote(value)),
        )
    }

    /// Declaration properties of a call. Imported declarations map to the application; local
    /// declarations retain authored locations with shorthands expanded.
    fn properties(
        &self,
        call: &Call<'a>,
        body: Option<&'a ObjectExpression<'a>>,
    ) -> Vec<ObjectPropertyKind<'a>> {
        if call.ownership.is_some() {
            let span = Span::new(call.start, call.start);
            let Some(style) = self.styles.get(&call.name) else {
                return Vec::new();
            };

            return declarations(style)
                .into_iter()
                .map(|declaration| {
                    let (value, raw) = self.literal(&declaration.property);
                    let key =
                        PropertyKey::new_string_literal(span, value, Some(raw.into()), &self.ast);
                    let value =
                        Expression::new_string_literal(span, "", Some("\"\"".into()), &self.ast);

                    ObjectPropertyKind::new_object_property(
                        span,
                        oxc_ast::ast::PropertyKind::Init,
                        key,
                        value,
                        false,
                        false,
                        false,
                        &self.ast,
                    )
                })
                .collect();
        }

        let Some(body) = body.or_else(|| self.bodies.get(&call.start).copied()) else {
            return Vec::new();
        };

        body.properties
            .iter()
            .flat_map(|property| {
                let ObjectPropertyKind::ObjectProperty(original) = property else {
                    return vec![property.clone_in_with_semantic_ids(self.allocator)];
                };

                if let Expression::ObjectExpression(value) = unwrap(&original.value) {
                    let nested =
                        ArenaVec::from_iter_in(self.properties(call, Some(value)), &self.allocator);
                    let mut copy = original.clone_in_with_semantic_ids(self.allocator);

                    copy.value = Expression::new_object_expression(value.span, nested, &self.ast);

                    return vec![ObjectPropertyKind::ObjectProperty(copy)];
                }

                let key = match &original.key {
                    PropertyKey::StaticIdentifier(identifier) => identifier.name.to_string(),
                    PropertyKey::Identifier(identifier) => identifier.name.to_string(),
                    key => key_literal(key).map(Cow::into_owned).unwrap_or_default(),
                };
                let span = original.key.span();
                let keys: Vec<Arc<str>> = call
                    .shorthands
                    .as_ref()
                    .and_then(|shorthands| shorthands.get(key.as_str()))
                    .map_or_else(|| vec![Arc::from(key.as_str())], |targets| targets.to_vec());

                keys.iter()
                    .map(|key| {
                        let (value, raw) = self.literal(key);
                        let mut copy = original.clone_in_with_semantic_ids(self.allocator);

                        copy.key = PropertyKey::new_string_literal(
                            span,
                            value,
                            Some(raw.into()),
                            &self.ast,
                        );

                        ObjectPropertyKind::ObjectProperty(copy)
                    })
                    .collect()
            })
            .collect()
    }

    fn body(&self, span: Span, selected: &[&Call<'a>]) -> &'a ObjectExpression<'a> {
        let properties = ArenaVec::from_iter_in(
            selected
                .iter()
                .flat_map(|call| self.properties(call, call.body)),
            &self.allocator,
        );

        self.allocator
            .alloc(ObjectExpression::new(span, properties, &self.ast))
    }
}

/// Collects ordered compositions of `cx(...)` calls.
///
/// # Errors
///
/// Returns `Themes.InvalidError` for unresolved, optional, conditional, or conflicting
/// composition arguments.
pub fn collect<'o, 'a>(options: Options<'o, 'a>) -> Result<Vec<Entry<'a>>> {
    if !imports_cx(options.program) {
        return Ok(Vec::new());
    }

    let applications = applications::create(
        options.program,
        options.semantic,
        options.calls,
        applications::Options { dynamic: true },
    );
    let bindings: Bindings<'_, 'a> = composition_bindings::create(options.semantic);
    let mut walker = Walker {
        aliases: FxHashMap::default(),
        ancestors: Vec::new(),
        bodies: FxHashMap::default(),
        calls: options
            .calls
            .iter()
            .map(|call| (call.start, call))
            .collect(),
        external_applications: Vec::new(),
        externals: Vec::new(),
        links: options.links,
        nodes: Vec::new(),
        semantic: options.semantic,
        undefined_reads: FxHashSet::default(),
    };

    walker.visit_program(options.program);

    let Walker {
        bodies,
        external_applications,
        externals,
        mut nodes,
        undefined_reads,
        ..
    } = walker;
    let mut applied: FxHashMap<u32, Application> = applications
        .iter()
        .flat_map(applications::Applications::find)
        .map(|application| (application.start, application.clone()))
        .collect();
    let mut by_name: FxHashMap<Arc<str>, Call<'a>> = options
        .calls
        .iter()
        .map(|call| (Arc::clone(&call.name), call.clone()))
        .collect();
    let mut styles: FxHashMap<Arc<str>, Arc<NamedStyle>> = options
        .styles
        .iter()
        .map(|style| (Arc::clone(&style.name), Arc::clone(style)))
        .collect();

    for application in external_applications {
        applied.insert(application.start, application);
    }

    for (call, style) in externals {
        styles.insert(Arc::clone(&call.name), style);
        by_name.insert(Arc::clone(&call.name), call);
    }

    let mut calls: FxHashMap<u32, Call<'a>> = options
        .calls
        .iter()
        .map(|call| (call.start, call.clone()))
        .collect();
    let mut result: Vec<Entry<'a>> = Vec::new();

    // Contained calls end first, so nested compositions resolve before the calls that read them.
    nodes.sort_by_key(|node| node.span.end);

    for node in &nodes {
        let entry = compose(
            node,
            &nodes,
            &options,
            &bindings,
            &undefined_reads,
            &applied,
            &by_name,
            &mut calls,
            &mut styles,
            &bodies,
        )?;

        result.push(entry);
    }

    let statics: Vec<(u32, u32)> = result
        .iter()
        .filter(|entry| entry.call.composition.is_some())
        .map(|entry| (entry.call.start, entry.call.end))
        .collect();

    result.retain(|entry| {
        !statics
            .iter()
            .any(|(start, end)| *start < entry.call.start && *end >= entry.call.end)
    });

    Ok(result)
}

#[expect(
    clippy::too_many_arguments,
    reason = "The composition loop shares the module's lookup tables."
)]
fn compose<'o, 'a>(
    node: &'a CallExpression<'a>,
    nodes: &[&'a CallExpression<'a>],
    options: &Options<'o, 'a>,
    bindings: &Bindings<'_, 'a>,
    undefined_reads: &FxHashSet<u32>,
    applied: &FxHashMap<u32, Application>,
    by_name: &FxHashMap<Arc<str>, Call<'a>>,
    calls: &mut FxHashMap<u32, Call<'a>>,
    styles: &mut FxHashMap<Arc<str>, Arc<NamedStyle>>,
    bodies: &FxHashMap<u32, &'a ObjectExpression<'a>>,
) -> Result<Entry<'a>> {
    let mut selected: Vec<Call<'a>> = Vec::new();
    let mut inputs: Vec<RuntimeInput> = Vec::new();
    let mut outputs: Vec<Option<Output>> = Vec::new();
    let mut runtime = false;
    let mut conditions: u32 = 0;
    let mut attributes: FxHashMap<Arc<str>, Arc<str>> = FxHashMap::default();
    let mut guards: Vec<Arc<str>> = Vec::new();

    let mut input = |inputs: &mut Vec<RuntimeInput>,
                     call: &Call<'a>,
                     span: Span,
                     condition: Option<u32>,
                     application_start: Option<u32>|
     -> Result<()> {
        let owned = owners(call);

        for owner in &owned {
            for attribute in &owner.attributes {
                if let Some(previous) = attributes.get(attribute)
                    && *previous != owner.identity
                {
                    return Err(invalid(
                        &format!("Recipe attribute {attribute} has conflicting owners."),
                        span,
                    ));
                }

                attributes.insert(Arc::clone(attribute), Arc::clone(&owner.identity));
            }
        }

        inputs.push(RuntimeInput {
            application_start,
            condition,
            end: span.end,
            known: None,
            name: Arc::clone(&call.name),
            owners: owned,
            start: span.start,
        });

        Ok(())
    };
    let placeholder = |span: Span| RuntimeInput {
        application_start: None,
        condition: None,
        end: span.end,
        known: None,
        name: Arc::from(""),
        owners: Vec::new(),
        start: span.start,
    };

    if node.optional {
        return Err(invalid(
            "Composition does not support optional calls.",
            node.span,
        ));
    }

    for argument in &node.arguments {
        let Some(argument) = argument.as_expression() else {
            return Err(invalid(
                "Composition requires statically known local style applications.",
                argument.span(),
            ));
        };
        let expression = unwrap(argument);
        let resolved = bindings.resolve(expression, nodes)?;
        let conditional = matches!(resolved, Expression::LogicalExpression(logical) if logical.operator == LogicalOperator::And);
        let value = match resolved {
            Expression::LogicalExpression(logical) if conditional => {
                bindings.resolve(&logical.right, nodes)?
            }
            _ => resolved,
        };
        let aliased = !std::ptr::eq(resolved, expression);

        runtime |= conditional || aliased;

        let omitted = omitted(value, undefined_reads);

        if conditional && omitted {
            return Err(invalid(
                "Conditional omissions must be evaluated outside composition.",
                expression.span(),
            ));
        }

        if omitted {
            if aliased {
                inputs.push(placeholder(expression.span()));
            }

            continue;
        }

        let Expression::CallExpression(value) = value else {
            return Err(invalid(
                "Composition requires statically known local style applications.",
                value.span(),
            ));
        };

        if value.optional {
            return Err(invalid(
                "Composition requires statically known local style applications.",
                value.span,
            ));
        }

        if let Some(scope) = options
            .scopes
            .and_then(|scopes| scopes.get(&value.span.start))
            && scope.end == value.span.end
        {
            outputs.push(scope.output);
            inputs.push(placeholder(expression.span()));
            runtime = true;
            continue;
        }

        let condition = conditional.then(|| {
            conditions += 1;
            conditions - 1
        });
        let nested = calls.get(&value.span.start).cloned();

        if nested
            .as_ref()
            .is_some_and(|nested| nested.composition_cases.is_some())
            && aliased
        {
            return Err(invalid(
                "Conditional composition results must remain direct arguments.",
                expression.span(),
            ));
        }

        if let Some(nested) = nested
            .as_ref()
            .filter(|nested| nested.composition_cases.is_some() && nested.end == value.span.end)
        {
            if conditional {
                return Err(invalid(
                    "Conditional nested compositions require flattening into one cx call.",
                    expression.span(),
                ));
            }

            for child in nested.runtime_composition.iter().flatten() {
                if child.name.is_empty() {
                    inputs.push(child.clone());
                    continue;
                }

                let call = by_name
                    .get(&child.name)
                    .cloned()
                    .or_else(|| calls.values().find(|call| call.name == child.name).cloned());
                let Some(call) = call else {
                    return Err(invalid(
                        "Nested composition has an unresolved definition.",
                        expression.span(),
                    ));
                };
                let condition = child.condition.map(|_| {
                    conditions += 1;
                    conditions - 1
                });

                input(
                    &mut inputs,
                    &call,
                    Span::new(child.start, child.end),
                    condition,
                    child.application_start,
                )?;
                selected.push(call);
            }

            runtime = true;
            continue;
        }

        if let Some(nested) = nested.filter(|nested| {
            nested.end == value.span.end
                && (nested.composition.is_some() || nested.runtime_composition.is_some())
        }) {
            guards.extend(nested.composition.iter().flatten().cloned());
            input(
                &mut inputs,
                &nested,
                expression.span(),
                condition,
                Some(value.span.start),
            )?;
            runtime |= nested.runtime_composition.is_some();
            selected.push(nested);
            continue;
        }

        let application = applied
            .get(&value.span.start)
            .filter(|found| found.end == value.span.end);
        let call = match application {
            Some(application) => by_name.get(&application.name).cloned(),
            None => match &value.callee {
                Expression::CallExpression(callee) => calls
                    .get(&callee.span.start)
                    .filter(|call| call.end == callee.span.end)
                    .cloned(),
                _ => None,
            },
        };
        let Some(call) =
            call.filter(|call| call.composition.is_none() && call.runtime_composition.is_none())
        else {
            return Err(invalid(
                "Composition requires statically known local style applications.",
                value.span,
            ));
        };

        input(
            &mut inputs,
            &call,
            expression.span(),
            condition,
            Some(value.span.start),
        )?;
        runtime |= call.ownership.is_some()
            || call.recipe.is_some()
            || call.slots.is_some()
            || !value.arguments.is_empty();

        if let Some(application) = application {
            let guard: Arc<str> = Arc::from(
                options
                    .source
                    .get(application.start as usize..application.callee_end as usize)
                    .unwrap_or_default(),
            );
            // Imported styles own nothing beyond their class when they bind no attributes or slots.
            let props = call
                .ownership
                .as_ref()
                .is_none_or(|owner| owner.attributes.is_empty() && owner.slots.is_empty());

            if props
                && !aliased
                && call.output.is_none()
                && call.recipe.is_none()
                && call.slots.is_none()
                && value.arguments.is_empty()
                && let Some(input) = inputs.last_mut()
            {
                input.known = Some(KnownInput {
                    callee: Arc::clone(&guard),
                    condition: match resolved {
                        Expression::LogicalExpression(logical) if conditional => {
                            Some(logical.left.span())
                        }
                        _ => None,
                    },
                    imported: call.ownership.is_some(),
                });
            }

            guards.push(guard);
        }

        selected.push(if call.ownership.is_some() {
            Call {
                start: value.span.start,
                ..call
            }
        } else {
            call
        });
    }

    outputs.extend(selected.iter().map(|call| call.output));

    if outputs.iter().any(Option::is_some) && outputs.iter().any(Option::is_none) {
        return Err(invalid(
            "Composition cannot mix HTML and React props.",
            node.span,
        ));
    }

    if conditions > 8 {
        return Err(invalid(
            "Composition supports at most eight conditional arguments.",
            node.span,
        ));
    }

    let name: Arc<str> = Arc::from(format!(
        "composition-{}-{}",
        options.identity,
        options.offsets.utf16(node.span.start)
    ));
    let style = Arc::new(NamedStyle {
        composition: independent(&selected, styles),
        css_output: Some(CssOutput::Atomic),
        declarations: Vec::new(),
        name: Arc::clone(&name),
        rules: Some(rules(&selected, styles)),
        targets: None,
    });
    let identities: Vec<&str> = selected
        .iter()
        .filter_map(|call| call.identity.as_deref())
        .collect();
    let synthesizer = Synthesizer {
        allocator: options.allocator,
        ast: AstBuilder::new(options.allocator),
        bodies,
        styles,
    };
    let references: Vec<&Call<'a>> = selected.iter().collect();
    let portable_all = portable(&references);
    let css_name = selected
        .iter()
        .map(|call| {
            let name = call
                .css_name
                .as_deref()
                .or(call.identity.as_deref())
                .unwrap_or("style");

            [call.css_namespace.as_deref().unwrap_or_default(), name]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("-")
        })
        .collect::<Vec<_>>()
        .join("-");
    let html = outputs.iter().any(Option::is_some);
    let mut call = Call {
        body: Some(synthesizer.body(node.span, &references)),
        css_name: Some(Arc::from(css_name)),
        end: node.span.end,
        identity: (!identities.is_empty()).then(|| Arc::from(identities.join(" "))),
        name: Arc::clone(&name),
        output: html.then_some(Output::Html),
        start: node.span.start,
        typography: Some(typography(&references, false)),
        typography_queries: Some(typography(&references, true)),
        ..Call::default()
    };

    if let Some((portable, inputs)) = portable_all {
        call.portable = Some(portable);
        call.portable_inputs = Some(inputs);
    }

    if runtime {
        call.runtime_composition = Some(inputs.clone());
    } else {
        call.composition = Some(guards);
    }

    calls.insert(node.span.start, call.clone());

    let mut cases = Vec::new();
    let mut names: Vec<Arc<str>> = Vec::new();
    // Omitted bindings retain evaluation but own no selected style.
    let selected_inputs: Vec<&RuntimeInput> = inputs
        .iter()
        .filter(|input| !input.name.is_empty())
        .collect();

    for mask in 0..(1_u32 << conditions) - 1 {
        let included: Vec<Call<'a>> = selected
            .iter()
            .zip(&selected_inputs)
            .filter(|(_, input)| {
                input
                    .condition
                    .is_none_or(|condition| mask & (1 << condition) != 0)
            })
            .map(|(call, _)| call.clone())
            .collect();
        let references: Vec<&Call<'a>> = included.iter().collect();
        let case_name: Arc<str> = Arc::from(format!("{name}-{mask}"));
        let mut case = Call {
            body: Some(synthesizer.body(node.span, &references)),
            composition_case: true,
            end: call.end,
            identity: Some(Arc::from(
                included
                    .iter()
                    .filter_map(|call| call.identity.as_deref())
                    .collect::<Vec<_>>()
                    .join(" "),
            )),
            name: Arc::clone(&case_name),
            start: call.start,
            typography: Some(typography(&references, false)),
            typography_queries: Some(typography(&references, true)),
            ..Call::default()
        };

        if let Some((portable, inputs)) = portable(&references) {
            case.portable = Some(portable);
            case.portable_inputs = Some(inputs);
        }

        let style = Arc::new(NamedStyle {
            composition: independent(&included, styles),
            css_output: Some(CssOutput::Atomic),
            declarations: Vec::new(),
            name: Arc::clone(&case_name),
            rules: Some(rules(&included, styles)),
            targets: None,
        });

        names.push(case_name);
        cases.push((case, style));
    }

    names.push(Arc::clone(&name));
    styles.insert(Arc::clone(&name), Arc::clone(&style));

    if conditions > 0 {
        call.composition_cases = Some(names);
        calls.insert(node.span.start, call.clone());
    }

    Ok(Entry { call, cases, style })
}
