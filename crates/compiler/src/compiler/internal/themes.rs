//! Extracts local theme data and validates its lexical source references.
//!
//! [`collect`] reads module-level configuration, theme, and variable-set factories and their
//! aliases without evaluating source. The extraction walk then passes each identifier read to
//! [`Themes::reference`], which records bound style calls, token reads, scope reads, selections,
//! and native variable reads. The link and call contracts here are shared across a module graph.

use std::sync::Arc;

use indexmap::{IndexMap, IndexSet};
use oxc_allocator::{Address, GetAddress};
use oxc_ast::AstKind;
use oxc_ast::ast::{
    self, Argument, ArrayExpressionElement, ArrowFunctionBody, ArrowFunctionExpression,
    BindingIdentifier, BindingPattern, CallExpression, Expression, FormalParameters, FunctionBody,
    ImportDeclarationSpecifier, ModuleExportName, ObjectPattern, ObjectPropertyKind, PropertyKey,
    PropertyKind, Statement, UnaryOperator, VariableDeclaration, VariableDeclarationKind,
    VariableDeclarator,
};
use oxc_span::{GetSpan, Span};
use rustc_hash::{FxBuildHasher, FxHashMap, FxHashSet};

use crate::compiler::internal::configurations::{self, Input, Reader};
use crate::compiler::internal::scope::{Declaration, Kind};
use crate::compiler::internal::syntax::Parsed;
use crate::compiler::internal::{expression, identifiers, packed_styles, statics};
use crate::compiler::source::NativeContext;
use crate::data::{Data, Object};
use crate::error::{Error, Result};
use crate::internal::binding;
use crate::internal::identity;
use crate::internal::rule_reference;
use crate::internal::theme::{self, Definition};
use crate::internal::token::{self, Contract, Mappings, Metadata};
use crate::internal::variable_sets::{self, BuildOptions};
use crate::js::{self, Record};
use crate::vars;

/// A `@function` signature: ordered parameters and the result syntax.
#[derive(Clone, Debug, PartialEq)]
pub struct FunctionSignature {
    /// Parameters in authored order.
    pub parameters: Vec<FunctionParameter>,
    /// Result syntax.
    pub returns: Arc<str>,
}

/// One `@function` parameter.
#[derive(Clone, Debug, PartialEq)]
pub struct FunctionParameter {
    /// Default value.
    pub default: Option<crate::runtime::recipe::Scalar>,
    /// Defined keys in authored order, which contracts and type annotations reproduce.
    pub keys: Vec<ParameterKey>,
    /// Custom property name, including `--`.
    pub name: Arc<str>,
    /// Accepted syntax.
    pub syntax: Option<Arc<str>>,
}

/// A key of a `@function` parameter object.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ParameterKey {
    /// `default`.
    Default,
    /// `name`.
    Name,
    /// `syntax`.
    Syntax,
}

/// The parameter keys an object defines, in its own-property order.
pub fn parameter_keys(object: &crate::data::Object) -> Vec<ParameterKey> {
    object
        .iter()
        .filter(|(_, value)| !value.is_undefined())
        .filter_map(|(key, _)| match &**key {
            "default" => Some(ParameterKey::Default),
            "name" => Some(ParameterKey::Name),
            "syntax" => Some(ParameterKey::Syntax),
            _ => None,
        })
        .collect()
}

/// Writes a parameter as `JSON.stringify` writes its authored object, so non-finite defaults
/// become `null`.
pub fn write_parameter(output: &mut String, parameter: &FunctionParameter) {
    output.push('{');

    for (index, key) in parameter.keys.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }

        match key {
            ParameterKey::Default => {
                output.push_str("\"default\":");

                match &parameter.default {
                    Some(crate::runtime::recipe::Scalar::Number(number)) if number.is_finite() => {
                        js::write_number(output, *number);
                    }
                    Some(crate::runtime::recipe::Scalar::String(text)) => {
                        js::write_string(output, text);
                    }
                    _ => output.push_str("null"),
                }
            }
            ParameterKey::Name => {
                output.push_str("\"name\":");
                js::write_string(output, &parameter.name);
            }
            ParameterKey::Syntax => {
                output.push_str("\"syntax\":");
                js::write_string(output, parameter.syntax.as_deref().unwrap_or_default());
            }
        }
    }

    output.push('}');
}

/// A configuration, theme, or variable-set authoring call.
#[derive(Clone, Debug, Default, PartialEq)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "Each flag is an independent property of the authored call."
)]
pub struct Call {
    /// Whether component-aware Base UI authoring is enabled.
    pub base_ui: bool,
    /// Whether the configuration only names a catalog of sets.
    pub catalog_only: bool,
    /// Whether the call reads variables directly.
    pub direct_variables: bool,
    /// `@function` signature of a CSS function factory.
    pub function: Option<FunctionSignature>,
    /// Whether the call initializes the scheme script.
    pub initialization: bool,
    /// Exclusive offset of the call.
    pub end: u32,
    /// Member scope keys by member path.
    pub members: Option<Record<Arc<str>>>,
    /// Scope key.
    pub name: Arc<str>,
    /// Whether the configuration targets a native provider.
    pub native_provider: bool,
    /// Evaluated configuration options.
    pub options: Option<Object>,
    /// `html` when the configuration emits HTML attributes.
    pub output: Option<Output>,
    /// Whether the call defines a recipe factory.
    pub recipe: bool,
    /// Named rule kind a reference call refers to.
    pub reference: Option<rule_reference::Kind>,
    /// Whether the call renders a root appearance helper.
    pub root: bool,
    /// Whether the call renders an appearance script.
    pub script: bool,
    /// Whether the call renders an appearance helper.
    pub appearance: bool,
    /// Whether the configuration selects named sets.
    pub selection: bool,
    /// Inclusive offset of the call.
    pub start: u32,
    /// Token type text for generated declarations.
    pub token_type: Arc<str>,
    /// Declared type text.
    pub type_text: Option<Arc<str>>,
    /// Whether the call configures variables.
    pub variable_config: bool,
    /// Category mappings for a variable configuration.
    pub variable_mappings: Option<Mappings>,
    /// Owning scope of variable reads.
    pub variable_owner: Option<Arc<str>>,
    /// Whether the call defines a variable set.
    pub variable_set: bool,
    /// Binding slots the call declares.
    pub variables: Option<Record<Arc<binding::Reference>>>,
}

/// Output mode for configured applications.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Output {
    /// HTML attribute props.
    Html,
}

/// A local alias of configured helpers, such as `const { style } = config`.
#[derive(Clone, Debug, Default)]
pub struct Alias {
    /// Helpers destructured from the configuration.
    pub bindings: Option<Vec<AliasBinding>>,
    /// The aliased call.
    pub call: Call,
    /// Whether helpers are destructured.
    pub destructured: bool,
    /// Whether the alias stays in the rewritten module.
    pub retained: bool,
}

/// A configured helper an alias destructures.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AliasBinding {
    /// `style`
    Style,
    /// `variants`
    Variants,
}

/// What an exported binding links to.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LinkKind {
    /// A keyframes animation.
    Animation,
    /// A configuration.
    Config,
    /// A named rule reference.
    RuleReference,
    /// A style definition.
    Style,
    /// A style reference.
    StyleReference,
    /// A theme.
    Theme,
    /// A variable set.
    Variables,
}

/// An exported authoring value that other modules of the graph can import.
#[derive(Clone, Debug, PartialEq)]
pub struct Link {
    /// Exported binding identity.
    pub binding: Arc<str>,
    /// The defining call.
    pub call: Call,
    /// The linked theme or configuration definition.
    pub definition: Arc<Definition>,
    /// What the link refers to.
    pub kind: LinkKind,
    /// Member links by member path.
    pub members: Option<Record<Link>>,
    /// Packed style data of a linked style.
    pub style: Option<Arc<packed_styles::Definition>>,
}

/// A configured `vars()` selection read for native output.
#[derive(Clone, Debug, PartialEq)]
pub struct VarsRead {
    /// Default set name.
    pub default_vars: Arc<str>,
    /// Exclusive offset.
    pub end: u32,
    /// Owning configuration scope key.
    pub owner: Arc<str>,
    /// Inclusive offset.
    pub start: u32,
    /// Whether the configuration has a single unnamed set.
    pub unnamed: bool,
    /// Selectable sets by name.
    pub vars: Record<Arc<Definition>>,
}

/// A read of a configured theme by scope key.
#[derive(Clone, Debug, PartialEq)]
pub struct Reference {
    /// Exclusive offset.
    pub end: u32,
    /// Scope key.
    pub name: Arc<str>,
    /// Inclusive offset.
    pub start: u32,
}

/// Graph context that links one module to the exports of others.
#[derive(Clone, Debug, Default)]
pub struct Context<'a> {
    /// Constants imported from other modules, by local name.
    pub constants: Option<Record<&'a Expression<'a>>>,
    /// Factory names imported from other modules, by local name.
    pub factories: Option<Record<Arc<str>>>,
    /// Identifiers declared across the graph.
    pub identifiers: Option<rustc_hash::FxHashSet<Arc<str>>>,
    /// Library exports by module identity.
    pub libraries: Option<Record<Record<Link>>>,
    /// Links imported into this module, by local name.
    pub links: Record<Link>,
    /// Owners of linked calls.
    pub owners: Option<Record<Owner>>,
    /// Class names of imported styles, by style name.
    pub style_classes: Option<Record<Arc<str>>>,
}

/// The module that defines a linked call.
#[derive(Clone, Debug)]
pub struct Owner {
    /// The defining call.
    pub call: Call,
    /// Module identity.
    pub module_id: Arc<str>,
    /// Module source.
    pub source: Arc<str>,
}

/// How a configured variable read in a native hook selects its alternatives.
///
/// Resolves the variable alternatives a linked configuration or variable set exposes to native
/// hooks, as `Themes.varsRead` does. `start` and `end` locate the read.
pub fn vars_read(
    call: &Call,
    definition: &Arc<Definition>,
    members: Option<&Record<Link>>,
    start: u32,
    end: u32,
) -> VarsRead {
    let named = call.options.as_ref().is_some_and(|options| {
        options
            .get("themes")
            .is_some_and(|themes| !themes.is_undefined())
    });
    let mut vars: Record<Arc<Definition>> = Record::new();

    if named {
        for (key, member) in members.into_iter().flat_map(Record::iter) {
            let path = member_path(key);

            match path.as_slice() {
                [name] if call.selection => {
                    vars.insert(name.as_str(), Arc::clone(&member.definition));
                }
                [first, name] if first == "themes" => {
                    vars.insert(name.as_str(), Arc::clone(&member.definition));
                }
                _ => {}
            }
        }
    } else {
        vars.insert("default", Arc::clone(definition));
    }

    VarsRead {
        default_vars: if named {
            call.options
                .as_ref()
                .and_then(|options| options.get("defaultTheme"))
                .map_or_else(
                    || Arc::from("undefined"),
                    |value| value.to_js_string().into(),
                )
        } else {
            Arc::from("default")
        },
        end,
        owner: Arc::clone(&call.name),
        start,
        unnamed: !named,
        vars,
    }
}

/// Parses a member key: the JSON encoding of a member path.
fn member_path(key: &str) -> Vec<String> {
    serde_json::from_str(key).unwrap_or_default()
}

/// Encodes a member path as its member key.
fn member_key<S: AsRef<str>>(path: &[S]) -> String {
    js::stringify(&js::Value::Array(
        path.iter()
            .map(|part| js::Value::from(part.as_ref()))
            .collect(),
    ))
}

/// Inputs supplied by the source adapter.
#[derive(Clone, Debug, Default)]
pub struct Options {
    /// Starts of stylesheet contribution calls whose arguments may hold token references.
    pub contribution_calls: FxHashSet<u32>,
    /// Whether the module compiles inside a linked source graph.
    pub linked: bool,
    /// Links imported into this module, by local name.
    pub links: Record<Link>,
    /// Stable module namespace, independent of token values and call offsets.
    pub namespace: Arc<str>,
    /// Whether readonly variable arguments of native React hooks are captured.
    pub native: bool,
    /// Declarator starts of immutable `const` bindings that static evaluation resolves.
    pub static_bindings: FxHashSet<u32>,
}

/// Selection scope applied by a compiled configuration call.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ScopeApplication {
    /// Exclusive offset of the application.
    pub end: u32,
    /// `html` when the configuration emits HTML attributes.
    pub output: Option<Output>,
}

/// A token reference outside a style call, inside a static binding the evaluator inlines.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StaticToken {
    /// Exclusive offset of the read, including TypeScript wrappers.
    pub end: u32,
    /// Inclusive offset of the read, including TypeScript wrappers.
    pub start: u32,
    /// Inclusive offset of the read without TypeScript wrappers.
    pub value_start: u32,
}

/// A style or recipe call bound to a theme.
#[derive(Clone, Debug)]
pub struct StyleCall<'a> {
    /// Whether component-aware Base UI authoring is enabled.
    pub base_ui: bool,
    /// The call.
    pub call: &'a CallExpression<'a>,
    /// `html` when the configuration emits HTML attributes.
    pub output: Option<Output>,
    /// Whether the call defines a recipe.
    pub recipe: bool,
    /// The bound theme.
    pub theme: Arc<Definition>,
}

/// A token reference read in a style declaration.
#[derive(Clone, Debug)]
pub struct TokenRead {
    /// Exclusive offset of the read.
    pub end: u32,
    /// The reference.
    pub reference: Arc<token::Reference>,
}

/// Factory functions imported by name.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Factory {
    /// `defineConfig`
    Create,
    /// `defineVars`
    Define,
    /// `extendVars`
    Extend,
}

/// An ordered set of scope keys.
pub type Names = IndexSet<Arc<str>, FxBuildHasher>;

/// Module-level themes, configurations, and the reads the extraction walk resolved.
///
/// Offsets are UTF-8 offsets into the module source. Calls imported through links have zero
/// offsets, standing in for the TypeScript `-1`: every comparison of a read with an imported
/// call's end is then false, as it is in TypeScript.
pub struct Themes<'a> {
    /// Local bound-authoring initializers replaced while retaining their inferred types.
    pub aliases: Vec<Alias>,
    /// Configurations whose root controls the module reads.
    pub appearances: Names,
    /// Configuration, theme, and variable-set factory calls.
    pub calls: Vec<Call>,
    /// Exported authoring values, by exported name.
    pub exports: Record<Link>,
    /// Theme `className` reads replaced with compiled constants.
    pub references: Vec<Reference>,
    /// Compiled scope selection calls, by start.
    pub scope_applications: IndexMap<u32, ScopeApplication, FxBuildHasher>,
    /// Configurations whose initialization script the module reads.
    pub scripts: Names,
    /// Configurations whose selection helper the module calls or passes.
    pub selection_uses: Names,
    /// Configurations whose selection the module reads.
    pub selections: Names,
    /// Token reads in static bindings.
    pub static_tokens: Vec<StaticToken>,
    /// Bound style and recipe calls, by call start.
    pub styles: IndexMap<u32, StyleCall<'a>, FxBuildHasher>,
    /// Themes and variable sets, by scope key.
    pub themes: Record<Arc<Definition>>,
    /// Token reads, by the start of the read and of its unwrapped expression.
    pub tokens: IndexMap<u32, TokenRead, FxBuildHasher>,
    /// Readonly variable arguments of native React hooks.
    pub vars_reads: Vec<VarsRead>,
    alias_bindings: FxHashMap<u32, Arc<Alias>>,
    alias_names: IndexMap<Arc<str>, Alias, FxBuildHasher>,
    alias_references: FxHashSet<u32>,
    base_ui_factories: FxHashSet<Arc<str>>,
    config_bindings: FxHashMap<u32, Arc<Link>>,
    config_imports: FxHashSet<u32>,
    config_namespaces: FxHashSet<Arc<str>>,
    configs: IndexMap<Arc<str>, Link, FxBuildHasher>,
    definitions: FxHashMap<u32, Arc<Call>>,
    export_references: FxHashSet<u32>,
    factories: FxHashSet<u32>,
    factory_functions: FxHashMap<Arc<str>, Factory>,
    factory_imports: FxHashMap<u32, Factory>,
    factory_references: FxHashSet<u32>,
    imports: FxHashSet<u32>,
    names: FxHashMap<Arc<str>, Call>,
    namespaces: FxHashSet<Arc<str>>,
    native_contexts: Vec<(Arc<Contract>, NativeContext)>,
    native_factories: FxHashSet<Arc<str>>,
    options: Options,
    variable_namespaces: FxHashSet<Arc<str>>,
}

#[cold]
fn fail<T>(message: &str, span: Span) -> Result<T> {
    Err(Error::Themes {
        message: message.to_owned(),
        span,
    })
}

/// The name an import or export specifier refers to.
fn export_name<'b>(name: &'b ModuleExportName<'_>) -> &'b str {
    match name {
        ModuleExportName::IdentifierName(identifier) => &identifier.name,
        ModuleExportName::IdentifierReference(identifier) => &identifier.name,
        ModuleExportName::StringLiteral(literal) => &literal.value,
    }
}

/// A member read's property as ESTree reports it.
#[derive(Clone, Copy, Debug)]
enum Property<'b, 'a> {
    /// An identifier, static or computed.
    Identifier(&'b str),
    /// A computed literal.
    Literal(&'b Expression<'a>),
    /// A private name or another computed expression.
    Other,
}

/// A member read.
#[derive(Clone, Copy, Debug)]
struct Member<'b, 'a> {
    computed: bool,
    object: &'b Expression<'a>,
    optional: bool,
    property: Property<'b, 'a>,
    span: Span,
}

impl<'b, 'a> Member<'b, 'a> {
    fn of_expression(expression: &'b Expression<'a>) -> Option<Self> {
        match expression {
            Expression::StaticMemberExpression(member) => Some(Self {
                computed: false,
                object: &member.object,
                optional: member.optional,
                property: Property::Identifier(&member.property.name),
                span: member.span,
            }),
            Expression::ComputedMemberExpression(member) => Some(Self {
                computed: true,
                object: &member.object,
                optional: member.optional,
                property: match &member.expression {
                    Expression::Identifier(identifier) => Property::Identifier(&identifier.name),
                    expression if statics::is_literal(expression) => Property::Literal(expression),
                    _ => Property::Other,
                },
                span: member.span,
            }),
            Expression::PrivateFieldExpression(member) => Some(Self {
                computed: false,
                object: &member.object,
                optional: member.optional,
                property: Property::Other,
                span: member.span,
            }),
            _ => None,
        }
    }

    fn of_kind(kind: AstKind<'a>) -> Option<Member<'a, 'a>> {
        match kind {
            AstKind::StaticMemberExpression(member) => Some(Member {
                computed: false,
                object: &member.object,
                optional: member.optional,
                property: Property::Identifier(&member.property.name),
                span: member.span,
            }),
            AstKind::ComputedMemberExpression(member) => Some(Member {
                computed: true,
                object: &member.object,
                optional: member.optional,
                property: match &member.expression {
                    Expression::Identifier(identifier) => Property::Identifier(&identifier.name),
                    expression if statics::is_literal(expression) => Property::Literal(expression),
                    _ => Property::Other,
                },
                span: member.span,
            }),
            AstKind::PrivateFieldExpression(member) => Some(Member {
                computed: false,
                object: &member.object,
                optional: member.optional,
                property: Property::Other,
                span: member.span,
            }),
            _ => None,
        }
    }

    /// The key of a static name or a computed string or number literal.
    fn key(&self) -> Option<String> {
        match self.property {
            Property::Identifier(name) if !self.computed => Some(name.to_owned()),
            Property::Literal(
                literal @ (Expression::StringLiteral(_) | Expression::NumericLiteral(_)),
            ) if self.computed => expression::literal_text(literal),
            _ => None,
        }
    }

    /// The key of a static name or any computed literal, spelled like `String(value)`.
    fn loose_key(&self) -> Option<String> {
        match self.property {
            Property::Identifier(name) if !self.computed => Some(name.to_owned()),
            Property::Literal(literal) => literal_string(literal),
            _ => None,
        }
    }
}

/// Spells a literal like `String(value)`.
fn literal_string(literal: &Expression<'_>) -> Option<String> {
    match literal {
        Expression::NumericLiteral(literal) => Some(js::number(literal.value)),
        Expression::RegExpLiteral(literal) => Some(
            literal
                .raw
                .as_ref()
                .map_or_else(String::new, ToString::to_string),
        ),
        literal => expression::literal_text(literal),
    }
}

/// Whether a node is the given expression, by identity.
fn is<T: GetAddress>(node: AstKind<'_>, expression: &T) -> bool {
    node.address() == expression.address()
}

/// The expression beneath a TypeScript wrapper.
fn wrapped<'a>(kind: AstKind<'a>) -> Option<&'a Expression<'a>> {
    #![expect(
        clippy::elidable_lifetime_names,
        reason = "The node and its child share one arena."
    )]
    match kind {
        AstKind::TSAsExpression(inner) => Some(&inner.expression),
        AstKind::TSSatisfiesExpression(inner) => Some(&inner.expression),
        AstKind::TSNonNullExpression(inner) => Some(&inner.expression),
        AstKind::TSTypeAssertion(inner) => Some(&inner.expression),
        _ => None,
    }
}

/// The expression body of an expression-bodied arrow function.
fn arrow_expression<'a>(arrow: &'a ArrowFunctionExpression<'a>) -> Option<&'a Expression<'a>> {
    match &arrow.body {
        ArrowFunctionBody::FunctionBody(_) => None,
        body => body.as_expression(),
    }
}

/// Lists ancestors as ESTree reports them, without oxc-only wrapper nodes.
///
/// Parameter lists, parameters wrapping their patterns, catch parameters, and import attribute
/// clauses have no ESTree node.
pub fn estree_ancestors<'a>(ancestors: &[AstKind<'a>]) -> Vec<AstKind<'a>> {
    ancestors
        .iter()
        .filter(|kind| {
            !matches!(
                kind,
                AstKind::FormalParameters(_)
                    | AstKind::FormalParameter(_)
                    | AstKind::CatchParameter(_)
                    | AstKind::WithClause(_)
            )
        })
        .copied()
        .collect()
}

/// A destructured configuration binding.
struct Binding<'a> {
    id: &'a BindingIdentifier<'a>,
    key: &'a str,
}

/// A derived-variables callback: its parameter name and literal body.
struct Derivation<'a> {
    body: Input<'a>,
    name: &'a str,
}

impl<'a> Themes<'a> {
    fn theme(&self, name: &str) -> Result<Arc<Definition>> {
        self.themes
            .get(name)
            .cloned()
            .ok_or_else(|| Error::message(format!("Unknown theme scope: {name}")))
    }

    /// Resolves an identifier or member path to a configuration, theme, or configuration member.
    fn resolve(&mut self, node: Input<'a>) -> Result<Option<Link>> {
        let Input::Expression(node) = node else {
            return Ok(None);
        };

        if let Expression::Identifier(identifier) = node {
            if let Some(config) = self.configs.get(identifier.name.as_str()) {
                return Ok(Some(config.clone()));
            }

            let Some(call) = self.names.get(identifier.name.as_str()).cloned() else {
                return Ok(None);
            };
            let definition = self.theme(&call.name)?;

            return Ok(Some(Link {
                binding: Arc::clone(&call.name),
                call,
                definition,
                kind: LinkKind::Theme,
                members: None,
                style: None,
            }));
        }

        let Some(member) = Member::of_expression(node) else {
            return Ok(None);
        };

        if member.optional {
            return Ok(None);
        }

        let mut path: Vec<String> = Vec::new();
        let mut root = node;

        while let Some(member) = Member::of_expression(root) {
            let key = member.key();

            let Some(key) = key.filter(|_| !member.optional) else {
                return Ok(None);
            };

            path.insert(0, key);
            root = member.object;
        }

        let config = match root {
            Expression::Identifier(identifier) => {
                self.configs.get(identifier.name.as_str()).cloned()
            }
            _ => None,
        };
        let Some(config) = config else {
            return Ok(None);
        };

        if !config.call.selection
            && !config.call.initialization
            && !config.call.root
            && let [key] = path.as_slice()
            && matches!(key.as_str(), "themes" | "vars" | "script" | "appearance")
        {
            let key = key.as_str();

            if config.call.variable_config && key == "themes" {
                return Ok(None);
            }

            if key == "script" {
                self.scripts.insert(Arc::clone(&config.call.name));
            }

            if key == "appearance" {
                self.appearances.insert(Arc::clone(&config.call.name));
            }

            if key == "themes" && !option_truthy(&config.call, "themes") {
                return Ok(None);
            }

            if key == "themes" || key == "vars" {
                self.selections.insert(Arc::clone(&config.call.name));
            }

            if key == "script" && !config.call.script {
                return fail(
                    "This packed configuration does not provide script(); rebuild its library with initialization support.",
                    node.span(),
                );
            }

            if key == "appearance" && !config.call.appearance {
                return fail(
                    "This packed configuration does not provide appearance; rebuild its library with root control support.",
                    node.span(),
                );
            }

            let mut members: Record<Link> = Record::new();

            if key == "themes" || key == "vars" {
                for (name, member) in config.members.iter().flat_map(Record::iter) {
                    let parts = member_path(name);

                    if parts.first().map(String::as_str) == Some("themes") {
                        members.insert(
                            member_key(parts.get(1..).unwrap_or_default()),
                            member.clone(),
                        );
                    }
                }
            }

            return Ok(Some(helper_link(&config, members, key, true)));
        }

        Ok(config
            .members
            .as_ref()
            .and_then(|members| members.get(&member_key(&path)))
            .cloned())
    }

    /// Reads a token reference through a theme, configuration, or derived-variables parameter.
    fn read_reference(
        &self,
        node: &'a Expression<'a>,
        derived: Option<(&str, &Data)>,
    ) -> Option<Arc<token::Reference>> {
        Member::of_expression(node)?;

        let mut path: Vec<String> = Vec::new();
        let mut root = node;

        while let Some(member) = Member::of_expression(root) {
            if member.optional {
                break;
            }

            path.insert(0, member.loose_key()?);
            root = member.object;
        }

        let Expression::Identifier(root) = root else {
            return None;
        };
        let name = root.name.as_str();
        let mut path = path.into_iter();
        let mut value: Data = 'value: {
            if let Some((derived, vars)) = derived
                && derived == name
            {
                break 'value vars.clone();
            }

            if let Some(call) = self.names.get(name) {
                if !call.variable_set
                    && !call.direct_variables
                    && !matches!(path.next().as_deref(), Some("vars" | "tokens"))
                {
                    return None;
                }

                break 'value self.themes.get(&call.name)?.tokens.clone();
            }

            let config = self.configs.get(name)?;

            if !config.call.variable_config
                || (!config.call.selection && path.next().as_deref() != Some("vars"))
            {
                return None;
            }

            self.themes.get(&config.call.name)?.tokens.clone()
        };

        for key in path {
            value = own_property(&value, &key);
        }

        match value {
            Data::Token(reference) => Some(reference),
            _ => None,
        }
    }

    /// Reads literal theme data without evaluating expressions.
    fn data(&mut self, node: Input<'a>, derived: Option<(&str, &Data)>) -> Result<Data> {
        let expression = match node {
            Input::Expression(expression) => expression,
            Input::Spread(span) => {
                return fail(
                    "Theme values must be literal data; expressions are not evaluated.",
                    span,
                );
            }
        };

        if let Some(reference) = self.read_reference(expression, derived) {
            self.factory_references.insert(expression.span().start);

            return Ok(Data::Token(reference));
        }

        match expression {
            Expression::TSAsExpression(inner) => {
                return self.data(Input::Expression(&inner.expression), derived);
            }
            Expression::TSSatisfiesExpression(inner) => {
                return self.data(Input::Expression(&inner.expression), derived);
            }
            Expression::CallExpression(call) if !call.optional => {
                if let Expression::StaticMemberExpression(callee) = &call.callee
                    && !callee.optional
                    && let Expression::Identifier(object) = &callee.object
                    && self.variable_namespaces.contains(object.name.as_str())
                    && derived.is_none_or(|(name, _)| name != object.name.as_str())
                    && callee.property.name == "compose"
                {
                    let [group, parts] = call.arguments.as_slice() else {
                        return fail(
                            "Vars.compose requires a literal domain and parts array.",
                            call.span,
                        );
                    };
                    let group = self.data(Input::argument(group), derived)?;
                    let parts = self.data(Input::argument(parts), derived)?;
                    let (Some(group @ ("color" | "spacing")), Data::Array(parts)) =
                        (group.as_str(), &parts)
                    else {
                        return fail(
                            "Vars.compose requires a literal domain and parts array.",
                            call.span,
                        );
                    };

                    self.factory_references.insert(callee.span.start);

                    return Ok(Data::Expression(vars::compose(group, parts)?));
                }
            }
            _ => {}
        }

        match expression {
            // `null` removes a path in `Vars.extend`, and other readers reject it.
            Expression::NullLiteral(_) => Ok(Data::Null),
            Expression::StringLiteral(literal) => Ok(Data::from(literal.value.as_str())),
            Expression::NumericLiteral(literal) => Ok(Data::Number(literal.value)),
            Expression::UnaryExpression(unary)
                if matches!(
                    unary.operator,
                    UnaryOperator::UnaryNegation | UnaryOperator::UnaryPlus
                ) && matches!(unary.argument, Expression::NumericLiteral(_)) =>
            {
                let Expression::NumericLiteral(literal) = &unary.argument else {
                    return fail(
                        "Theme values must be literal data; expressions are not evaluated.",
                        unary.span,
                    );
                };

                Ok(Data::Number(
                    if unary.operator == UnaryOperator::UnaryNegation {
                        -literal.value
                    } else {
                        literal.value
                    },
                ))
            }
            Expression::ArrayExpression(array) => {
                let mut items = Vec::with_capacity(array.elements.len());

                for element in &array.elements {
                    let element = match element {
                        ArrayExpressionElement::SpreadElement(_)
                        | ArrayExpressionElement::Elision(_) => None,
                        element => element.as_expression(),
                    };
                    let Some(element) = element else {
                        return fail("Theme arrays require dense literal elements.", array.span);
                    };

                    items.push(self.data(Input::Expression(element), derived)?);
                }

                Ok(Data::Array(Arc::new(items)))
            }
            Expression::ObjectExpression(object) => {
                let mut result = Object::new();

                for property in &object.properties {
                    let ObjectPropertyKind::ObjectProperty(property) = property else {
                        return fail(
                            "Theme data requires explicit properties without spreads, methods, or computed keys.",
                            property.span(),
                        );
                    };

                    if property.computed
                        || property.method
                        || property.shorthand
                        || property.kind != PropertyKind::Init
                    {
                        return fail(
                            "Theme data requires explicit properties without spreads, methods, or computed keys.",
                            property.span,
                        );
                    }

                    let key = match &property.key {
                        PropertyKey::StaticIdentifier(identifier) => {
                            Some(identifier.name.to_string())
                        }
                        PropertyKey::StringLiteral(literal) => Some(literal.value.to_string()),
                        PropertyKey::NumericLiteral(literal) => Some(js::number(literal.value)),
                        _ => None,
                    };
                    let Some(key) = key.filter(|key| !result.has(key)) else {
                        return fail("Theme data requires unique literal keys.", property.span);
                    };
                    let value = self.data(Input::Expression(&property.value), derived)?;

                    result.insert(key, value);
                }

                Ok(Data::from(result))
            }
            expression => fail(
                "Theme values must be literal data; expressions are not evaluated.",
                expression.span(),
            ),
        }
    }

    /// Reads a derived-variables callback as one parameter name and a literal body.
    fn derivation(argument: Option<&'a Argument<'a>>) -> Result<Option<Derivation<'a>>> {
        let Some(argument) = argument else {
            return Ok(None);
        };
        let Some(callback) = argument.as_expression().map(expression::unwrap) else {
            return Ok(None);
        };
        let (span, asynchronous, generator, parameters, this, body): (
            Span,
            bool,
            bool,
            &'a FormalParameters<'a>,
            bool,
            Option<Input<'a>>,
        ) = match callback {
            Expression::ArrowFunctionExpression(arrow) => {
                let body = match &arrow.body {
                    ArrowFunctionBody::FunctionBody(body) => block_return(body),
                    body => body.as_expression().map(Input::Expression),
                };

                (arrow.span, arrow.r#async, false, &arrow.params, false, body)
            }
            Expression::FunctionExpression(function) => (
                function.span,
                function.r#async,
                function.generator,
                &function.params,
                function.this_param.is_some(),
                function.body.as_deref().and_then(block_return),
            ),
            _ => return Ok(None),
        };
        let count =
            parameters.items.len() + usize::from(parameters.rest.is_some()) + usize::from(this);
        let parameter = match parameters.items.first() {
            Some(parameter) if !this && parameter.initializer.is_none() => parameter
                .pattern
                .get_binding_identifier()
                .filter(|_| matches!(parameter.pattern, BindingPattern::BindingIdentifier(_))),
            _ => None,
        };

        match (asynchronous || generator || count != 1, parameter, body) {
            (false, Some(parameter), Some(body)) => Ok(Some(Derivation {
                body,
                name: parameter.name.as_str(),
            })),
            _ => fail(
                "Derived variables require one named parameter and a literal return value.",
                span,
            ),
        }
    }

    /// Encodes a literal argument's type, keeping authored object key order.
    fn type_of(&mut self, node: Input<'a>) -> Result<String> {
        let expression = match node {
            Input::Expression(Expression::TSAsExpression(inner)) => {
                return self.type_of(Input::Expression(&inner.expression));
            }
            Input::Expression(Expression::TSSatisfiesExpression(inner)) => {
                return self.type_of(Input::Expression(&inner.expression));
            }
            Input::Expression(Expression::ObjectExpression(object)) => object,
            node => return Ok(configurations::type_text(&self.data(node, None)?)),
        };
        let mut output = String::from("{");

        for (index, property) in expression.properties.iter().enumerate() {
            let ObjectPropertyKind::ObjectProperty(property) = property else {
                return fail("Expected validated theme properties.", property.span());
            };
            let key = match &property.key {
                PropertyKey::StaticIdentifier(identifier) => js::quote(&identifier.name),
                PropertyKey::StringLiteral(literal) => js::quote(&literal.value),
                PropertyKey::NumericLiteral(literal) => {
                    let mut text = String::new();

                    js::write_value(&mut text, &js::Value::Number(literal.value));
                    text
                }
                PropertyKey::BooleanLiteral(literal) => literal.value.to_string(),
                PropertyKey::NullLiteral(_) => "null".to_owned(),
                key => return fail("Expected a literal theme key.", key.span()),
            };

            if index > 0 {
                output.push(';');
            }

            output.push_str("readonly ");
            output.push_str(&key);
            output.push(':');
            output.push_str(&self.type_of(Input::Expression(&property.value))?);
        }

        output.push('}');

        Ok(output)
    }
}

/// Whether the call's options hold a truthy value for a key.
fn option_truthy(call: &Call, key: &str) -> bool {
    call.options
        .as_ref()
        .and_then(|options| options.get(key))
        .is_some_and(|value| match value {
            Data::Undefined | Data::Null => false,
            Data::Bool(value) => *value,
            Data::Number(number) => *number != 0.0 && !number.is_nan(),
            Data::String(text) => !text.is_empty(),
            _ => true,
        })
}

/// A configuration helper link: a selection, initialization script, or root controls.
///
/// Member reads such as `config.themes` key the binding by helper; destructured helpers keep the
/// configuration binding.
fn helper_link(config: &Link, members: Record<Link>, key: &str, keyed: bool) -> Link {
    let mut call = config.call.clone();

    call.members = Some(
        members
            .iter()
            .map(|(name, member)| (Arc::clone(name), Arc::clone(&member.call.name)))
            .collect(),
    );

    match key {
        "script" => call.initialization = true,
        "appearance" => call.root = true,
        _ => call.selection = true,
    }

    call.type_text = Some(
        format!(
            "{}['{key}']",
            config.call.type_text.as_deref().unwrap_or("undefined")
        )
        .into(),
    );

    Link {
        binding: if keyed {
            format!("{}:{key}", config.binding).into()
        } else {
            Arc::clone(&config.binding)
        },
        call,
        members: Some(members),
        ..config.clone()
    }
}

/// Reads `own[key]` like `Object.getOwnPropertyDescriptor(own, key)?.value`.
fn own_property(value: &Data, key: &str) -> Data {
    match value {
        Data::Object(object) => object.get(key).cloned().unwrap_or(Data::Undefined),
        Data::Array(items) => {
            if key == "length" {
                #[expect(clippy::cast_precision_loss, reason = "Array lengths are small.")]
                return Data::Number(items.len() as f64);
            }

            js::array_index(key)
                .and_then(|index| items.get(index as usize))
                .cloned()
                .unwrap_or(Data::Undefined)
        }
        Data::Token(reference) => match key {
            "group" => Data::from(reference.group.as_str()),
            "path" => Data::String(Arc::clone(&reference.path)),
            "value" => variable_sets::value_data(&reference.value),
            _ => Data::Undefined,
        },
        _ => Data::Undefined,
    }
}

/// The single returned expression of a block body: ESTree counts directives as statements.
fn block_return<'a>(body: &'a FunctionBody<'a>) -> Option<Input<'a>> {
    if !body.directives.is_empty() || body.statements.len() != 1 {
        return None;
    }

    match body.statements.first() {
        Some(Statement::ReturnStatement(statement)) => {
            statement.argument.as_ref().map(Input::Expression)
        }
        _ => None,
    }
}

/// The configuration-literal reader the theme collector supplies.
struct ConfigReader<'t, 'a> {
    statics: &'t statics::Static<'a>,
    themes: &'t mut Themes<'a>,
}

impl<'a> Reader<'a> for ConfigReader<'_, 'a> {
    fn data(&mut self, node: Input<'a>) -> Result<Data> {
        let node = match node {
            Input::Expression(expression) => Input::Expression(self.statics.normalize(
                expression,
                &FxHashSet::from_iter([expression.span().start]),
                &FxHashSet::default(),
                false,
            )?),
            node @ Input::Spread(_) => node,
        };

        self.themes.data(node, None)
    }

    fn resolve(&mut self, node: Input<'a>) -> Result<Option<Link>> {
        let link = self.themes.resolve(node)?;

        if link.is_some() {
            self.themes.factory_references.insert(node.span().start);
        }

        Ok(link)
    }
}

/// Collects immutable module-level themes and configurations without evaluating source.
///
/// Returns `None` when the module imports no theme factories and links no contracts.
///
/// # Errors
///
/// Returns `Source.ThemeInvalidError` for unsupported or invalid theme syntax, and a plain error
/// for malformed definition options, which the extractor does not locate.
pub fn collect<'a>(
    parsed: &Parsed<'a>,
    options: Options,
    statics: &statics::Static<'a>,
) -> Result<Option<Themes<'a>>> {
    let program = parsed.program;
    let mut themes = Themes {
        aliases: Vec::new(),
        appearances: Names::default(),
        calls: Vec::new(),
        exports: Record::new(),
        references: Vec::new(),
        scope_applications: IndexMap::default(),
        scripts: Names::default(),
        selection_uses: Names::default(),
        selections: Names::default(),
        static_tokens: Vec::new(),
        styles: IndexMap::default(),
        themes: Record::new(),
        tokens: IndexMap::default(),
        vars_reads: Vec::new(),
        alias_bindings: FxHashMap::default(),
        alias_names: IndexMap::default(),
        alias_references: FxHashSet::default(),
        base_ui_factories: FxHashSet::default(),
        config_bindings: FxHashMap::default(),
        config_imports: FxHashSet::default(),
        config_namespaces: FxHashSet::default(),
        configs: IndexMap::default(),
        definitions: FxHashMap::default(),
        export_references: FxHashSet::default(),
        factories: FxHashSet::default(),
        factory_functions: FxHashMap::default(),
        factory_imports: FxHashMap::default(),
        factory_references: FxHashSet::default(),
        imports: FxHashSet::default(),
        names: FxHashMap::default(),
        namespaces: FxHashSet::default(),
        native_contexts: Vec::new(),
        native_factories: FxHashSet::default(),
        options,
        variable_namespaces: FxHashSet::default(),
    };
    let mut variable_imports: FxHashSet<u32> = FxHashSet::default();

    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        let source = import.source.value.as_str();

        if !matches!(
            source,
            "zyzz" | "zyzz/base-ui/react" | "zyzz/react-native" | "zyzz/react-native/react"
        ) || import.import_kind.is_type()
        {
            continue;
        }

        for specifier in import.specifiers.iter().flatten() {
            let ImportDeclarationSpecifier::ImportSpecifier(named) = specifier else {
                continue;
            };

            if named.import_kind.is_type() {
                continue;
            }

            let imported = export_name(&named.imported);
            let start = named.span.start;

            if !matches!(source, "zyzz" | "zyzz/base-ui/react") {
                if imported == "defineConfig" {
                    themes.factory_imports.insert(start, Factory::Create);
                    themes
                        .native_factories
                        .insert(Arc::from(named.local.name.as_str()));
                }

                continue;
            }

            match imported {
                "Vars" => {
                    themes.imports.insert(start);
                    variable_imports.insert(start);
                }
                "Config" => {
                    themes.config_imports.insert(start);
                }
                "defineConfig" => {
                    themes.factory_imports.insert(start, Factory::Create);

                    if source == "zyzz/base-ui/react" {
                        themes
                            .base_ui_factories
                            .insert(Arc::from(named.local.name.as_str()));
                    }
                }
                "defineVars" => {
                    themes.factory_imports.insert(start, Factory::Define);
                }
                "extendVars" => {
                    themes.factory_imports.insert(start, Factory::Extend);
                }
                _ => {}
            }
        }
    }

    if themes.imports.is_empty()
        && themes.config_imports.is_empty()
        && themes.factory_imports.is_empty()
        && themes.options.links.is_empty()
    {
        return Ok(None);
    }

    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };

        if import.import_kind.is_type() {
            continue;
        }

        for specifier in import.specifiers.iter().flatten() {
            let local = specifier.local().name.as_str();
            let Some(link) = themes.options.links.get(local).cloned() else {
                continue;
            };

            if matches!(
                link.kind,
                LinkKind::StyleReference
                    | LinkKind::Animation
                    | LinkKind::RuleReference
                    | LinkKind::Variables
            ) {
                continue;
            }

            let call = detached(&link.call);
            let start = specifier.span().start;

            themes
                .themes
                .insert(Arc::clone(&call.name), Arc::clone(&link.definition));

            match link.kind {
                LinkKind::Config => {
                    let members: Record<Link> = link
                        .members
                        .iter()
                        .flat_map(Record::iter)
                        .map(|(key, member)| {
                            (
                                Arc::clone(key),
                                Link {
                                    call: detached(&member.call),
                                    ..member.clone()
                                },
                            )
                        })
                        .collect();

                    for member in link.members.iter().flat_map(Record::values) {
                        themes.themes.insert(
                            Arc::clone(&member.call.name),
                            Arc::clone(&member.definition),
                        );
                    }

                    let imported = Link {
                        call,
                        members: Some(members),
                        ..link
                    };

                    themes.configs.insert(Arc::from(local), imported.clone());
                    themes.config_bindings.insert(start, Arc::new(imported));
                }
                LinkKind::Theme => {
                    themes.definitions.insert(start, Arc::new(call.clone()));
                    themes.names.insert(Arc::from(local), call);
                }
                _ => {
                    let alias = Alias {
                        call,
                        ..Alias::default()
                    };

                    themes.alias_bindings.insert(start, Arc::new(alias.clone()));
                    themes.alias_names.insert(Arc::from(local), alias);
                }
            }
        }
    }

    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };

        for specifier in import.specifiers.iter().flatten() {
            let start = specifier.span().start;
            let local: Arc<str> = Arc::from(specifier.local().name.as_str());

            if variable_imports.contains(&start) {
                themes.variable_namespaces.insert(Arc::clone(&local));
            }

            if themes.imports.contains(&start) {
                themes.namespaces.insert(local);
            } else if themes.config_imports.contains(&start) {
                themes.config_namespaces.insert(local);
            } else if let Some(factory) = themes.factory_imports.get(&start).copied() {
                themes.factory_functions.insert(local, factory);
            }
        }
    }

    for statement in &program.body {
        let (declaration, exported) = match statement {
            Statement::VariableDeclaration(declaration) => (&**declaration, false),
            Statement::ExportDeclaration(export) => match &export.declaration {
                ast::Declaration::VariableDeclaration(declaration) => (&**declaration, true),
                _ => continue,
            },
            _ => continue,
        };

        for variable in &declaration.declarations {
            themes.register_alias(declaration, exported, variable)?;
            themes.factory(declaration, exported, variable, statics)?;
        }
    }

    if themes.options.linked {
        for statement in &program.body {
            let Statement::ExportNamedDeclaration(export) = statement else {
                continue;
            };

            if export.export_kind.is_type() {
                continue;
            }

            for specifier in &export.specifiers {
                if specifier.export_kind.is_type() {
                    continue;
                }

                let name = export_name(&specifier.local);
                let call = themes
                    .configs
                    .get(name)
                    .map(|config| config.call.clone())
                    .or_else(|| themes.names.get(name).cloned())
                    .or_else(|| themes.alias_names.get(name).map(|alias| alias.call.clone()));
                let Some(call) = call else {
                    continue;
                };
                let exported = export_name(&specifier.exported);
                let link = match themes
                    .configs
                    .get(name)
                    .or_else(|| themes.options.links.get(name))
                {
                    Some(link) => link.clone(),
                    None => Link {
                        binding: format!("{}-{name}", themes.options.namespace).into(),
                        definition: themes.theme(&call.name)?,
                        kind: if themes.names.contains_key(name) {
                            LinkKind::Theme
                        } else {
                            LinkKind::Style
                        },
                        call,
                        members: None,
                        style: None,
                    },
                };

                themes.exports.insert(exported, link);
                themes
                    .export_references
                    .insert(specifier.local.span().start);
            }
        }
    }

    let mut scripts = Vec::new();
    let mut appearances = Vec::new();

    for link in themes.exports.values() {
        if link.kind == LinkKind::Config
            && !link.call.selection
            && !link.call.initialization
            && !link.call.root
        {
            if link.call.script {
                scripts.push(Arc::clone(&link.call.name));
            }

            if link.call.appearance {
                appearances.push(Arc::clone(&link.call.name));
            }
        }
    }

    themes.scripts.extend(scripts);
    themes.appearances.extend(appearances);

    Ok(Some(themes))
}

/// An imported call, detached from this module's offsets.
fn detached(call: &Call) -> Call {
    Call {
        end: 0,
        start: 0,
        ..call.clone()
    }
}

impl<'a> Themes<'a> {
    /// Applies destructured configuration bindings.
    ///
    /// `provider` skips a `Provider` binding, which native configurations supply as a runtime
    /// component.
    fn destructure(
        &mut self,
        link: &Link,
        bindings: &[Binding<'a>],
        exported: bool,
        provider: bool,
    ) -> Result<()> {
        for binding in bindings {
            let key = binding.key;
            let id = binding.id;

            if key == "Provider" && provider {
                continue;
            }

            if (key == "style" || key == "variants")
                && !link.call.selection
                && !link.call.initialization
            {
                let alias = Alias {
                    call: Call {
                        recipe: key == "variants",
                        ..link.call.clone()
                    },
                    ..Alias::default()
                };

                self.alias_bindings
                    .insert(id.span.start, Arc::new(alias.clone()));
                self.alias_names
                    .insert(Arc::from(id.name.as_str()), alias.clone());

                if exported {
                    self.exports.insert(
                        id.name.as_str(),
                        Link {
                            binding: format!("{}-{}", self.options.namespace, id.name).into(),
                            call: alias.call,
                            kind: LinkKind::Style,
                            ..link.clone()
                        },
                    );
                }

                continue;
            }

            if !link.call.selection
                && !link.call.initialization
                && !link.call.root
                && (key == "script"
                    || key == "appearance"
                    || (key == "themes" && option_truthy(&link.call, "themes"))
                    || (key == "vars" && link.call.variable_config))
            {
                if (key == "script" && !link.call.script)
                    || (key == "appearance" && !link.call.appearance)
                    || link.call.selection
                    || link.call.initialization
                {
                    return fail(
                        "This configuration helper is not available on the linked contract.",
                        id.span,
                    );
                }

                if key == "script" {
                    self.scripts.insert(Arc::clone(&link.call.name));
                }

                if key == "appearance" {
                    self.appearances.insert(Arc::clone(&link.call.name));
                }

                if key == "themes" || key == "vars" {
                    self.selections.insert(Arc::clone(&link.call.name));
                }

                let mut members: Record<Link> = Record::new();

                if key == "themes" || key == "vars" {
                    for (name, member) in link.members.iter().flat_map(Record::iter) {
                        let path = member_path(name);

                        if matches!(path.first().map(String::as_str), Some("themes" | "vars")) {
                            members.insert(
                                member_key(path.get(1..).unwrap_or_default()),
                                member.clone(),
                            );
                        }
                    }
                }

                let selection = helper_link(link, members, key, false);

                self.configs
                    .insert(Arc::from(id.name.as_str()), selection.clone());
                self.config_bindings
                    .insert(id.span.start, Arc::new(selection.clone()));

                if exported {
                    self.exports.insert(id.name.as_str(), selection);
                }

                continue;
            }

            if link.call.variable_config && (key == "theme" || key == "themes") {
                return fail("Use vars for references and scope selection.", id.span);
            }

            let Some(member) = link
                .members
                .as_ref()
                .and_then(|members| members.get(&member_key(&[key])))
                .cloned()
            else {
                return fail(
                    "Destructure only style and the configured single theme; other helpers remain unsupported.",
                    id.span,
                );
            };

            self.definitions
                .insert(id.span.start, Arc::new(member.call.clone()));
            self.names
                .insert(Arc::from(id.name.as_str()), member.call.clone());

            if exported {
                self.exports.insert(id.name.as_str(), member);
            }
        }

        Ok(())
    }

    /// Records a local alias of linked authoring: configuration destructuring, a retained alias,
    /// or a theme style alias.
    fn register_alias(
        &mut self,
        declaration: &'a VariableDeclaration<'a>,
        exported: bool,
        variable: &'a VariableDeclarator<'a>,
    ) -> Result<()> {
        let Some(expression) = &variable.init else {
            return Ok(());
        };
        let linked = self.resolve(Input::Expression(expression))?;
        let constant = declaration.kind == VariableDeclarationKind::Const;

        if let Some(link) = &linked
            && link.kind == LinkKind::Config
            && let BindingPattern::ObjectPattern(pattern) = &variable.id
        {
            if exported && !self.options.linked {
                return fail(
                    "Exported configuration destructuring requires source linking.",
                    variable.span,
                );
            }

            if !constant {
                return fail(
                    "Configuration destructuring requires const bindings.",
                    variable.span,
                );
            }

            let bindings = pattern_bindings(
                pattern,
                "Configuration destructuring requires named bindings without defaults or rest.",
            )?;

            self.alias_references.insert(expression.span().start);
            self.aliases.push(Alias {
                call: Call {
                    end: expression.span().end,
                    start: expression.span().start,
                    ..link.call.clone()
                },
                retained: true,
                ..Alias::default()
            });

            let provider = link.call.native_provider
                && !link.call.initialization
                && !link.call.root
                && !link.call.selection;

            return self.destructure(link, &bindings, exported, provider);
        }

        if let Some(linked) = linked
            && let BindingPattern::BindingIdentifier(id) = &variable.id
        {
            if expression.span().start < linked.call.end {
                return fail(
                    "Authoring aliases must follow their definition.",
                    expression.span(),
                );
            }

            if !constant || (exported && !self.options.linked) {
                return fail(
                    "Authoring aliases require module-level const bindings.",
                    variable.span,
                );
            }

            if linked.kind == LinkKind::Config {
                self.configs
                    .insert(Arc::from(id.name.as_str()), linked.clone());
                self.config_bindings
                    .insert(id.span.start, Arc::new(linked.clone()));
            } else {
                self.names
                    .insert(Arc::from(id.name.as_str()), linked.call.clone());
                self.definitions
                    .insert(id.span.start, Arc::new(linked.call.clone()));
            }

            self.aliases.push(Alias {
                call: Call {
                    end: expression.span().end,
                    start: expression.span().start,
                    ..linked.call.clone()
                },
                retained: true,
                ..Alias::default()
            });
            self.alias_references.insert(expression.span().start);

            if exported {
                self.exports.insert(id.name.as_str(), linked);
            }

            return Ok(());
        }

        let member = match expression {
            Expression::StaticMemberExpression(member)
                if !member.optional
                    && matches!(member.property.name.as_str(), "style" | "variants") =>
            {
                Some(&member.object)
            }
            _ => None,
        };
        let destructured = matches!(variable.id, BindingPattern::ObjectPattern(_))
            && matches!(expression, Expression::Identifier(_));
        let source = match (member, expression) {
            (Some(member), _) => member,
            (None, Expression::Identifier(_)) => expression,
            _ => return Ok(()),
        };
        let theme = if member.is_some() || destructured {
            self.resolve(Input::Expression(source))?
                .map(|link| link.call)
        } else if let Expression::Identifier(identifier) = source {
            self.alias_names
                .get(identifier.name.as_str())
                .map(|alias| alias.call.clone())
        } else {
            None
        };
        let Some(theme) = theme else {
            return Ok(());
        };
        let bindings: Vec<(&'a BindingIdentifier<'a>, AliasBinding)> = match &variable.id {
            BindingPattern::ObjectPattern(pattern) if destructured => {
                if pattern.properties.is_empty() && pattern.rest.is_none() {
                    return fail(
                        "Theme destructuring requires an authoring binding.",
                        pattern.span,
                    );
                }

                let mut bindings = Vec::with_capacity(pattern.properties.len());

                for property in &pattern.properties {
                    let key = match &property.key {
                        PropertyKey::StaticIdentifier(key) if !property.computed => {
                            Some(key.name.as_str())
                        }
                        _ => None,
                    };
                    let (Some(key @ ("style" | "variants")), BindingPattern::BindingIdentifier(id)) =
                        (key, &property.value)
                    else {
                        return fail(
                            "Destructure only style or variants into const bindings without defaults or rest properties.",
                            property.span,
                        );
                    };

                    bindings.push((
                        &**id,
                        if key == "variants" {
                            AliasBinding::Variants
                        } else {
                            AliasBinding::Style
                        },
                    ));
                }

                if let Some(rest) = &pattern.rest {
                    return fail(
                        "Destructure only style or variants into const bindings without defaults or rest properties.",
                        rest.span,
                    );
                }

                bindings
            }
            BindingPattern::BindingIdentifier(id) => {
                let recipe = match expression {
                    Expression::StaticMemberExpression(member) => {
                        member.property.name == "variants"
                    }
                    _ => theme.recipe,
                };

                vec![(
                    &**id,
                    if recipe {
                        AliasBinding::Variants
                    } else {
                        AliasBinding::Style
                    },
                )]
            }
            _ => {
                return fail(
                    "Theme authoring aliases require named const bindings.",
                    variable.span,
                );
            }
        };

        if !constant || (exported && !self.options.linked) {
            return fail(
                "Theme style aliases require a local module-level const binding.",
                variable.span,
            );
        }

        if expression.span().start < theme.end {
            return fail(
                "Theme style aliases must follow their definition.",
                expression.span(),
            );
        }

        let members: Vec<AliasBinding> = bindings.iter().map(|(_, member)| *member).collect();

        for (index, (id, member)) in bindings.iter().enumerate() {
            let alias = Alias {
                call: Call {
                    end: expression.span().end,
                    name: Arc::clone(&theme.name),
                    options: theme.options.clone(),
                    output: theme.output,
                    recipe: *member == AliasBinding::Variants,
                    start: expression.span().start,
                    token_type: Arc::clone(&theme.token_type),
                    type_text: theme.type_text.clone(),
                    variable_config: theme.variable_config,
                    variable_mappings: theme.variable_mappings.clone(),
                    ..Call::default()
                },
                destructured,
                ..Alias::default()
            };

            if index == 0 {
                self.aliases.push(Alias {
                    bindings: Some(members.clone()),
                    ..alias.clone()
                });
            }

            self.alias_bindings
                .insert(id.span.start, Arc::new(alias.clone()));
            self.alias_names
                .insert(Arc::from(id.name.as_str()), alias.clone());

            if exported {
                let definition = self.theme(&alias.call.name)?;

                self.exports.insert(
                    id.name.as_str(),
                    Link {
                        binding: format!("{}-{}", self.options.namespace, id.name).into(),
                        call: alias.call,
                        definition,
                        kind: LinkKind::Style,
                        members: None,
                        style: None,
                    },
                );
            }
        }

        self.alias_references.insert(source.span().start);

        Ok(())
    }

    /// Collects a configuration, theme, or variable-set factory declaration.
    fn factory(
        &mut self,
        declaration: &'a VariableDeclaration<'a>,
        exported: bool,
        variable: &'a VariableDeclarator<'a>,
        statics: &statics::Static<'a>,
    ) -> Result<()> {
        let Some(Expression::CallExpression(expression)) = &variable.init else {
            return Ok(());
        };

        if expression.optional {
            return Ok(());
        }

        let direct = match &expression.callee {
            Expression::Identifier(identifier) => self
                .factory_functions
                .get(identifier.name.as_str())
                .copied(),
            _ => None,
        };
        let member = match &expression.callee {
            Expression::StaticMemberExpression(member) => match &member.object {
                Expression::Identifier(object) => Some((object.name.as_str(), member)),
                _ => None,
            },
            _ => None,
        };
        let namespaced = member.is_some_and(|(object, member)| {
            !member.optional
                && if self.config_namespaces.contains(object) {
                    member.property.name == "create"
                } else {
                    self.namespaces.contains(object)
                        && matches!(member.property.name.as_str(), "define" | "extend")
                }
        });

        if direct.is_none() && !namespaced {
            return Ok(());
        }

        let config = direct == Some(Factory::Create)
            || member.is_some_and(|(object, _)| self.config_namespaces.contains(object));
        let method = match (member, direct) {
            (Some((_, member)), _) => member.property.name.as_str(),
            (None, Some(Factory::Create)) => "create",
            (None, Some(Factory::Define)) => "define",
            (None, Some(Factory::Extend)) => "extend",
            (None, None) => return Ok(()),
        };
        let variable_set = matches!(direct, Some(Factory::Define | Factory::Extend))
            || member.is_some_and(|(object, _)| self.variable_namespaces.contains(object));

        if (exported && !self.options.linked)
            || declaration.kind != VariableDeclarationKind::Const
            || !(matches!(variable.id, BindingPattern::BindingIdentifier(_))
                || (config && matches!(variable.id, BindingPattern::ObjectPattern(_))))
        {
            return fail(
                "Define local themes with a module-level const; exported themes require source linking.",
                variable.span,
            );
        }

        let bindings = match &variable.id {
            BindingPattern::ObjectPattern(pattern) => pattern_bindings(
                pattern,
                "Configuration destructuring requires named bindings without defaults, rest, or nested patterns.",
            )?,
            _ => Vec::new(),
        };
        let binding: Arc<str> = match &variable.id {
            BindingPattern::BindingIdentifier(id) => Arc::from(id.name.as_str()),
            _ => match bindings.first() {
                Some(binding) => Arc::from(binding.id.name.as_str()),
                None => {
                    return fail(
                        "Configuration destructuring requires a binding.",
                        variable.span,
                    );
                }
            },
        };
        let mut name: Arc<str> = format!("{}-{binding}", self.options.namespace).into();
        let callback = |index: usize| {
            matches!(
                expression
                    .arguments
                    .get(index)
                    .and_then(Argument::as_expression)
                    .map(expression::unwrap),
                Some(Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_))
            )
        };

        if !config && method == "define" {
            let index = if callback(1) { 2 } else { 1 };

            if let Some(id) = identifiers::explicit(expression, index)? {
                name = identity::require_id(Some(&id), "Vars.define")?.into();
            }
        }

        if !config && method == "extend" {
            let index = if callback(2) { 3 } else { 2 };

            if let Some(id) = identifiers::explicit(expression, index)? {
                name = identity::require_id(Some(&id), "Vars.extend")?.into();
            }
        }

        if config {
            let native_provider = matches!(
                &expression.callee,
                Expression::Identifier(identifier)
                    if self.native_factories.contains(identifier.name.as_str())
            );

            if native_provider && !self.options.native {
                return fail(
                    "Native defineConfig requires a native compilation target.",
                    expression.span,
                );
            }

            return configurations::collect(
                &mut ConfigReader {
                    statics,
                    themes: self,
                },
                expression,
                &name,
                native_provider,
            )
            .and_then(|link| self.config(expression, variable, &bindings, link, exported))
            .map_err(|error| match error {
                Error::Config(_) | Error::Vars { .. } => Error::Themes {
                    message: error.text(),
                    span: expression.span,
                },
                error => error,
            });
        }

        let (mut definition, token_type, output) =
            match self.theme_definition(expression, method, variable_set, &binding, &mut name) {
                Ok(result) => result,
                Err(error @ (Error::Theme { .. } | Error::Vars { .. })) => {
                    return fail(&error.text(), expression.span);
                }
                Err(error) => return Err(error),
            };
        let html = output == Some(Output::Html);
        let shorthands = definition.metadata.contract.shorthands.clone();
        let mut type_text = variable_set
            .then(|| Arc::from(format!("import('zyzz').Vars.Definition<{token_type}>")));

        if shorthands.is_some() || html {
            let shorthands = Data::from(Object::from_entries(
                shorthands
                    .iter()
                    .flat_map(|map| map.iter())
                    .map(|(key, targets)| {
                        (
                            Arc::clone(key),
                            Data::Array(Arc::new(
                                targets
                                    .iter()
                                    .map(|target| Data::String(Arc::clone(target)))
                                    .collect(),
                            )),
                        )
                    }),
            ));

            type_text = Some(Arc::from(format!(
                "import('zyzz').Config.create.ReturnType<{{theme:{token_type};{}shorthands:{}}}>['theme']",
                if html { "output:'html';" } else { "" },
                configurations::type_text(&shorthands)
            )));
        }

        let call = Call {
            direct_variables: variable_set,
            end: expression.span.end,
            name: Arc::clone(&name),
            output,
            start: expression.span.start,
            token_type: Arc::from(token_type),
            type_text,
            variable_set,
            ..Call::default()
        };
        let contract = Arc::clone(&definition.metadata.contract);

        definition = token::bind(&definition, &contract, Some(&binding))?;

        let definition = Arc::new(definition);
        let BindingPattern::BindingIdentifier(id) = &variable.id else {
            return Ok(());
        };

        self.calls.push(call.clone());
        self.definitions
            .insert(id.span.start, Arc::new(call.clone()));
        self.factories.insert(expression.span.start);
        self.names.insert(Arc::clone(&binding), call.clone());
        self.themes
            .insert(Arc::clone(&name), Arc::clone(&definition));

        if exported {
            self.exports.insert(
                binding,
                Link {
                    binding: name,
                    call,
                    definition,
                    kind: LinkKind::Theme,
                    members: None,
                    style: None,
                },
            );
        }

        Ok(())
    }

    /// Collects a configuration factory and applies its destructured bindings.
    fn config(
        &mut self,
        expression: &'a CallExpression<'a>,
        variable: &'a VariableDeclarator<'a>,
        bindings: &[Binding<'a>],
        mut link: Link,
        exported: bool,
    ) -> Result<()> {
        if let Expression::Identifier(identifier) = &expression.callee {
            link.call.base_ui = self.base_ui_factories.contains(identifier.name.as_str());
        }

        if link.call.base_ui && link.call.output == Some(Output::Html) {
            return fail(
                "Base UI configuration requires React output.",
                expression.span,
            );
        }

        if let BindingPattern::BindingIdentifier(id) = &variable.id {
            self.configs
                .insert(Arc::from(id.name.as_str()), link.clone());
            self.config_bindings
                .insert(id.span.start, Arc::new(link.clone()));

            if exported {
                self.exports.insert(id.name.as_str(), link.clone());
            }
        }

        self.calls.push(link.call.clone());
        self.factories.insert(expression.span.start);

        for member in link.members.iter().flat_map(Record::values) {
            self.themes.insert(
                Arc::clone(&member.call.name),
                Arc::clone(&member.definition),
            );
        }

        self.themes
            .insert(Arc::clone(&link.call.name), Arc::clone(&link.definition));

        let provider = link.call.native_provider;

        self.destructure(&link, bindings, exported, provider)
    }

    /// Defines or extends a theme or variable set, returning its definition, token type, and
    /// output. An unnamed extension of an explicitly identified base renames its scope.
    fn theme_definition(
        &mut self,
        expression: &'a CallExpression<'a>,
        method: &str,
        variable_set: bool,
        binding: &str,
        name: &mut Arc<str>,
    ) -> Result<(Definition, String, Option<Output>)> {
        let arguments = &expression.arguments;

        if method == "define" {
            if arguments.is_empty() || arguments.len() > 3 {
                return fail(
                    "Vars.define requires one literal variable object.",
                    expression.span,
                );
            }

            let first = arguments
                .first()
                .map_or(Input::Spread(expression.span), Input::argument);
            let mut input = self.data(first, None)?;
            let mut token_type = self.type_of(first)?;
            let derive = if variable_set {
                Self::derivation(arguments.get(1))?
            } else {
                None
            };
            let contract = Arc::new(Contract {
                identity: Some(Arc::clone(name)),
                variable_set: true,
                ..Contract::default()
            });

            if let Some(derive) = derive {
                let base = variable_sets::build(&input, &contract, &BuildOptions::default())?;
                let derived = self.data(derive.body, Some((derive.name, &base.tokens)))?;

                input = variable_sets::merge(&input, &derived, &[])?;
                token_type = configurations::type_text(&input);
            } else if arguments.len() > 2 {
                return fail(
                    "Vars.define accepts a third argument only with a derived callback.",
                    expression.span,
                );
            }

            let original = if variable_set {
                variable_sets::theme(
                    &variable_sets::build(&input, &contract, &BuildOptions::default())?,
                    None,
                )?
            } else {
                theme::define(&input, None)?
            };
            let contract = Arc::new(Contract {
                identity: Some(Arc::clone(name)),
                ..(*original.metadata.contract).clone()
            });

            return Ok((token::bind(&original, &contract, None)?, token_type, None));
        }

        let base = arguments.first().map(Input::argument);
        let parent = match base {
            Some(base) => self.resolve(base)?.map(|link| link.call),
            None => None,
        };
        let derive = if variable_set {
            Self::derivation(arguments.get(2))?
        } else {
            None
        };
        let arity = if derive.is_some() { 3 } else { 2 };
        let id = if arguments.len() == arity + 1 {
            identifiers::explicit(expression, arity)?
        } else {
            None
        };
        let named = id.is_some();
        let (Some(base), Some(parent)) =
            (base, parent.filter(|_| arguments.len() == arity || named))
        else {
            return fail(
                "Vars.extend requires a preceding variable set and literal overrides.",
                expression.span,
            );
        };

        self.factory_references.insert(base.span().start);

        let mut token_type = parent.token_type.to_string();
        let output = parent.output;
        let theme = self.theme(&parent.name)?;
        let overrides = arguments
            .get(1)
            .map_or(Input::Spread(expression.span), Input::argument);
        let definition = if variable_set {
            let original = variable_sets::from(&theme.metadata)?;
            let values = self.data(overrides, None)?;
            let mut derive_values = |vars: &Definition| -> Result<Data> {
                match &derive {
                    Some(derive) => self.data(derive.body, Some((derive.name, &vars.tokens))),
                    None => Ok(Data::from(Object::new())),
                }
            };
            let extended =
                vars::extend(&original, &values, Some(&mut derive_values), id.as_deref())?;
            let wrapped = variable_sets::theme(&extended, None)?;
            let definition = if named {
                let contract = Arc::new(Contract {
                    identity: Some(Arc::clone(name)),
                    ..(*extended.metadata.contract).clone()
                });

                token::bind(&wrapped, &contract, None)?
            } else {
                wrapped
            };
            let metadata = &definition.metadata;

            if named
                || metadata.values.len() != theme.metadata.values.len()
                || queries_json(metadata) != queries_json(&theme.metadata)
            {
                let mut tree = extended_values(&theme, &definition)
                    .as_object()
                    .cloned()
                    .unwrap_or_default();

                for (key, value) in configurations::queries(metadata) {
                    tree.insert(key, value);
                }

                token_type = configurations::type_text(&Data::from(tree));
            }

            definition
        } else {
            let values = self.data(overrides, None)?;

            theme::extend(&theme, &values)?
        };

        if !named
            && definition
                .metadata
                .contract
                .identity
                .as_deref()
                .is_some_and(|identity| identity.starts_with("id-"))
        {
            let class_name = definition.class_name()?;

            *name = format!(
                "{}-{binding}",
                js::slice(&class_name, "z-theme-".len(), js::utf16_len(&class_name))
            )
            .into();
        }

        Ok((definition, token_type, output))
    }
}

/// Reads destructured configuration bindings: named properties without defaults or rest.
fn pattern_bindings<'a>(pattern: &'a ObjectPattern<'a>, message: &str) -> Result<Vec<Binding<'a>>> {
    let mut bindings = Vec::with_capacity(pattern.properties.len());

    for property in &pattern.properties {
        let key = match &property.key {
            PropertyKey::StaticIdentifier(key) if !property.computed => Some(key.name.as_str()),
            _ => None,
        };
        let (Some(key), BindingPattern::BindingIdentifier(id)) = (key, &property.value) else {
            return fail(message, property.span);
        };

        bindings.push(Binding { id, key });
    }

    if let Some(rest) = &pattern.rest {
        return fail(message, rest.span);
    }

    Ok(bindings)
}

/// Serializes query metadata like `JSON.stringify(metadata.queries)`.
fn queries_json(metadata: &Metadata) -> Option<String> {
    metadata.queries.as_ref()?;

    let mut object = js::Object::new();

    for (key, value) in configurations::queries(metadata) {
        object.insert(key, json(&value));
    }

    Some(js::stringify(&js::Value::Object(object)))
}

/// Converts plain data to a JSON value.
fn json(value: &Data) -> js::Value {
    match value {
        Data::Array(items) => js::Value::Array(items.iter().map(json).collect()),
        Data::Bool(value) => js::Value::Bool(*value),
        Data::Number(number) => js::Value::Number(*number),
        Data::Object(object) => {
            let mut result = js::Object::new();

            for (key, value) in object.iter() {
                result.insert(key.to_string(), json(value));
            }

            js::Value::Object(result)
        }
        Data::String(text) => js::Value::String(text.to_string()),
        _ => js::Value::Null,
    }
}

/// Authored values of an extension, keeping base values at existing paths as `Vars.extend` types
/// do.
fn extended_values(base: &Definition, extension: &Definition) -> Data {
    let metadata = &extension.metadata;
    let known = &base.metadata.values;
    let mut tree = theme::TreeBuilder::default();

    for path in metadata.values.keys() {
        let parts: Vec<Arc<str>> = metadata
            .paths
            .as_ref()
            .and_then(|paths| paths.get(path))
            .map_or_else(
                || path.split('.').map(Arc::from).collect(),
                |parts| parts.to_vec(),
            );
        let source = if known.contains_key(path) {
            base
        } else {
            extension
        };
        let mut token = &source.tokens;

        for part in parts.iter().take(parts.len().saturating_sub(1)) {
            token = token
                .as_object()
                .and_then(|object| object.get(part))
                .unwrap_or(&Data::Undefined);
        }

        let value = parts
            .last()
            .and_then(|name| token.as_object().and_then(|object| object.get(name)))
            .map_or(Data::Undefined, |leaf| match leaf {
                Data::Token(reference) => variable_sets::value_data(&reference.value),
                _ => Data::Undefined,
            });

        tree.insert(&parts, value);
    }

    tree.finish()
}

impl<'a> Themes<'a> {
    /// Resolves one identifier read during the extraction walk.
    ///
    /// `node` is an `IdentifierReference` or a JSX identifier that oxc-walker classifies as a
    /// reference. `ancestors` lists the walk's ancestors from the program down to `node`
    /// inclusive; oxc-only wrapper nodes are skipped as ESTree reports them. `binding` is the
    /// declaration `node` resolves to, and `lookup` resolves a name from the scope of `node`.
    ///
    /// Returns whether the read belongs to theme authoring. Bound style calls, token reads, scope
    /// reads, selections, and native variable reads are recorded on the collector.
    ///
    /// # Errors
    ///
    /// Returns `Source.ThemeInvalidError` for reads that escape, mutate, or precede their
    /// definitions, which the extractor reports before continuing its walk.
    pub fn reference(
        &mut self,
        node: AstKind<'a>,
        ancestors: &[AstKind<'a>],
        binding: Option<&Declaration<'a>>,
        lookup: &dyn Fn(&str) -> Option<Declaration<'a>>,
    ) -> Result<bool> {
        let ancestors = estree_ancestors(ancestors);
        let length = ancestors.len();
        let Some(parent) = length
            .checked_sub(2)
            .and_then(|index| ancestors.get(index))
            .copied()
        else {
            return Ok(false);
        };
        let grandparent = length
            .checked_sub(3)
            .and_then(|index| ancestors.get(index))
            .copied();
        let start = node.span().start;

        if let Some(binding) = binding
            && binding.kind == Kind::Import
            && (self.imports.contains(&binding.start())
                || self.config_imports.contains(&binding.start())
                || self.factory_imports.contains_key(&binding.start()))
        {
            if self.factory_imports.contains_key(&binding.start())
                && matches!(parent, AstKind::CallExpression(call) if self.factories.contains(&call.span.start))
            {
                return Ok(true);
            }

            if Member::of_kind(parent).is_some()
                && let Some(AstKind::CallExpression(call)) = grandparent
                && (self.factories.contains(&call.span.start)
                    || self.factory_references.contains(&parent.span().start))
            {
                return Ok(true);
            }

            return fail(
                "Theme factories require direct module-level const declarations; aliases and indirect references require source linking.",
                node.span(),
            );
        }

        let local = binding.filter(|binding| matches!(binding.kind, Kind::Variable | Kind::Import));

        if let Some(binding) = local
            && let Some(alias) = self.alias_bindings.get(&binding.start()).cloned()
        {
            if start == binding.start() || self.export_references.contains(&start) {
                return Ok(true);
            }

            if start < alias.call.end {
                return fail(
                    "Theme style alias references must follow their definition.",
                    node.span(),
                );
            }

            if self.alias_references.contains(&start) {
                return Ok(true);
            }

            let AstKind::CallExpression(call) = parent else {
                return fail(
                    "Theme style aliases support direct calls only; exporting or escaping them requires source linking.",
                    node.span(),
                );
            };

            if !is(node, &call.callee) || call.optional {
                return fail(
                    "Theme style aliases support direct calls only; exporting or escaping them requires source linking.",
                    node.span(),
                );
            }

            let theme = self.theme(&alias.call.name)?;
            let output = alias.call.output.or_else(|| html(&alias.call));

            self.styles.insert(
                call.span.start,
                StyleCall {
                    base_ui: alias.call.base_ui,
                    call,
                    output,
                    recipe: alias.call.recipe,
                    theme,
                },
            );

            return Ok(true);
        }

        if let Some(binding) = local
            && let Some(config) = self.config_bindings.get(&binding.start()).cloned()
        {
            return self.config_reference(node, &ancestors, binding, &config, lookup);
        }

        let Some(theme) = local.and_then(|binding| self.definitions.get(&binding.start()).cloned())
        else {
            return Ok(false);
        };

        if local.is_some_and(|binding| start == binding.start()) {
            return Ok(true);
        }

        if theme.variable_set {
            let definition = self.theme(&theme.name)?;

            if self.read_vars(node, parent, &theme, &definition, None, lookup) {
                return Ok(true);
            }
        }

        self.theme_reference(node, parent, &ancestors, &theme)
    }

    /// Resolves a read of a configuration binding.
    fn config_reference(
        &mut self,
        node: AstKind<'a>,
        ancestors: &[AstKind<'a>],
        binding: &Declaration<'a>,
        config: &Link,
        lookup: &dyn Fn(&str) -> Option<Declaration<'a>>,
    ) -> Result<bool> {
        let length = ancestors.len();
        let at = |index: usize| ancestors.get(index).copied();
        let Some(parent) = length.checked_sub(2).and_then(at) else {
            return Ok(false);
        };
        let start = node.span().start;
        let call = &config.call;

        if start == binding.start()
            || self.export_references.contains(&start)
            || self.alias_references.contains(&start)
        {
            return Ok(true);
        }

        // Imported calls have no local offsets, so the TypeScript `start >= 0` test is implied.
        if start < call.end && binding.kind != Kind::Import {
            return fail(
                "Configuration references must follow their definition.",
                node.span(),
            );
        }

        if call.variable_config
            && call.selection
            && self.read_vars(
                node,
                parent,
                call,
                &config.definition,
                config.members.as_ref(),
                lookup,
            )
        {
            return Ok(true);
        }

        // Root controls are an ordinary runtime object; any read or call is valid.
        if call.root {
            self.appearances.insert(Arc::clone(&call.name));

            return Ok(true);
        }

        if (call.selection || call.initialization)
            && let AstKind::CallExpression(application) = parent
            && is(node, &application.callee)
            && !application.optional
        {
            if call.selection && call.catalog_only {
                return fail(
                    "This legacy catalog is not callable; rebuild its library.",
                    node.span(),
                );
            }

            if call.selection {
                self.selections.insert(Arc::clone(&call.name));
                self.selection_uses.insert(Arc::clone(&call.name));
                self.scope_applications.insert(
                    application.span.start,
                    ScopeApplication {
                        end: application.span.end,
                        output: html(call),
                    },
                );
            }

            if call.initialization {
                self.scripts.insert(Arc::clone(&call.name));
            }

            return Ok(true);
        }

        let mut target = node;
        let mut path: Vec<String> = Vec::new();
        let mut index = length.checked_sub(2);

        while let Some(position) = index {
            let Some(member) = at(position).and_then(Member::of_kind) else {
                break;
            };
            let Some(kind) = at(position) else {
                break;
            };

            if !is(target, member.object) || member.optional {
                break;
            }

            let Some(key) = member.key() else {
                break;
            };

            path.push(key);
            target = kind;

            let next = position.checked_sub(1).and_then(at);
            let first = path.first().map(String::as_str);
            let single = path.len() == 1;

            if single
                && first == Some("Provider")
                && call.native_provider
                && !call.initialization
                && !call.root
                && !call.selection
            {
                return Ok(true);
            }

            if call.variable_config
                && single
                && first == Some("vars")
                && let Some(next) = next
                && self.read_vars(
                    target,
                    next,
                    call,
                    &config.definition,
                    config.members.as_ref(),
                    lookup,
                )
            {
                return Ok(true);
            }

            if self.alias_references.contains(&target.span().start)
                || self.factory_references.contains(&target.span().start)
            {
                return Ok(true);
            }

            if single && first == Some("appearance") && !call.selection && !call.initialization {
                if !call.appearance {
                    return fail(
                        "This packed configuration does not provide appearance; rebuild its library with root control support.",
                        target.span(),
                    );
                }

                self.appearances.insert(Arc::clone(&call.name));

                return Ok(true);
            }

            if single
                && !call.selection
                && !call.initialization
                && matches!(first, Some("script" | "themes" | "vars"))
                && let Some(AstKind::CallExpression(application)) = next
                && is(target, &application.callee)
                && !application.optional
            {
                if first == Some("vars") && !call.variable_config {
                    return fail("This configuration has no vars.", target.span());
                }

                if first == Some("themes") && !option_truthy(call, "themes") {
                    return fail("Theme selection requires a named catalog.", target.span());
                }

                if matches!(first, Some("themes" | "vars")) && call.catalog_only {
                    return fail(
                        "This legacy catalog is not callable; rebuild its library.",
                        target.span(),
                    );
                }

                if first == Some("script") {
                    if !call.script {
                        return fail(
                            "This packed configuration does not provide script(); rebuild its library with initialization support.",
                            target.span(),
                        );
                    }

                    self.scripts.insert(Arc::clone(&call.name));
                }

                if matches!(first, Some("themes" | "vars")) {
                    self.selections.insert(Arc::clone(&call.name));
                    self.selection_uses.insert(Arc::clone(&call.name));
                    self.scope_applications.insert(
                        application.span.start,
                        ScopeApplication {
                            end: application.span.end,
                            output: html(call),
                        },
                    );
                }

                return Ok(true);
            }

            if single && matches!(first, Some("style" | "variants")) {
                let Some(AstKind::CallExpression(style)) = next else {
                    break;
                };

                if !is(target, &style.callee) || style.optional {
                    break;
                }

                self.styles.insert(
                    style.span.start,
                    StyleCall {
                        base_ui: call.base_ui,
                        call: style,
                        output: html(call),
                        recipe: first == Some("variants"),
                        theme: Arc::clone(&config.definition),
                    },
                );

                return Ok(true);
            }

            if call.variable_config && matches!(first, Some("theme" | "themes")) {
                return fail(
                    "Use vars for references and scope selection.",
                    target.span(),
                );
            }

            let linked = if call.variable_config && call.selection {
                None
            } else {
                config
                    .members
                    .as_ref()
                    .and_then(|members| members.get(&member_key(&path)))
                    .cloned()
            };

            if let Some(linked) = linked {
                let Some(next) = next else {
                    break;
                };

                return self.theme_reference(
                    target,
                    next,
                    ancestors.get(..=position).unwrap_or_default(),
                    &linked.call,
                );
            }

            index = position.checked_sub(1);
        }

        if call.selection && call.variable_config && !path.is_empty() {
            return self.theme_reference(
                node,
                parent,
                ancestors,
                &Call {
                    direct_variables: true,
                    ..call.clone()
                },
            );
        }

        // A compiled selector is an ordinary runtime function, so passing or storing it is safe.
        if call.selection && !call.catalog_only && path.is_empty() {
            self.selections.insert(Arc::clone(&call.name));
            self.selection_uses.insert(Arc::clone(&call.name));

            return Ok(true);
        }

        fail(
            "Use direct configuration style calls or static theme members; configurations cannot escape or be mutated.",
            node.span(),
        )
    }

    /// Records a configured variable argument of a native React hook.
    fn read_vars(
        &mut self,
        node: AstKind<'a>,
        parent: AstKind<'a>,
        call: &Call,
        definition: &Arc<Definition>,
        members: Option<&Record<Link>>,
        lookup: &dyn Fn(&str) -> Option<Declaration<'a>>,
    ) -> bool {
        let AstKind::CallExpression(hook) = parent else {
            return false;
        };

        if !self.options.native
            || hook.optional
            || !hook
                .arguments
                .first()
                .is_some_and(|argument| is(node, argument))
        {
            return false;
        }

        let name = match &hook.callee {
            Expression::Identifier(identifier) => Some(identifier.name.as_str()),
            Expression::StaticMemberExpression(member)
                if !member.optional
                    && matches!(member.property.name.as_str(), "useAnimatedVars" | "useVars") =>
            {
                match &member.object {
                    Expression::Identifier(object) => Some(object.name.as_str()),
                    _ => None,
                }
            }
            _ => None,
        };
        let Some(binding) = name.and_then(lookup) else {
            return false;
        };
        let Some(import) = binding.import.filter(|_| binding.kind == Kind::Import) else {
            return false;
        };

        if !matches!(
            import.source.value.as_str(),
            "zyzz/react-native" | "zyzz/react-native/reanimated" | "zyzz/react-native/react"
        ) || import.import_kind.is_type()
        {
            return false;
        }

        let specifier = import
            .specifiers
            .iter()
            .flatten()
            .find(|specifier| specifier.span().start == binding.start());
        let matches = match (&hook.callee, specifier) {
            (
                Expression::Identifier(_),
                Some(ImportDeclarationSpecifier::ImportSpecifier(specifier)),
            ) => {
                !specifier.import_kind.is_type()
                    && matches!(
                        export_name(&specifier.imported),
                        "useAnimatedVars" | "useVars"
                    )
            }
            (Expression::Identifier(_), _) => false,
            (_, specifier) => matches!(
                specifier,
                Some(ImportDeclarationSpecifier::ImportNamespaceSpecifier(_))
            ),
        };

        if !matches {
            return false;
        }

        let span = node.span();

        self.vars_reads
            .push(vars_read(call, definition, members, span.start, span.end));

        true
    }

    /// Resolves a read of a theme or configured theme member.
    fn theme_reference(
        &mut self,
        node: AstKind<'a>,
        parent: AstKind<'a>,
        ancestors: &[AstKind<'a>],
        theme: &Call,
    ) -> Result<bool> {
        let length = ancestors.len();
        let at = |index: isize| {
            usize::try_from(index)
                .ok()
                .and_then(|index| ancestors.get(index))
                .copied()
        };
        let signed = |value: usize| isize::try_from(value).unwrap_or(isize::MAX);
        let grandparent = at(signed(length) - 3);
        let start = node.span().start;

        if self.factory_references.contains(&start)
            || ancestors
                .iter()
                .any(|ancestor| self.factory_references.contains(&ancestor.span().start))
            || self.export_references.contains(&start)
            || self.alias_references.contains(&start)
        {
            return Ok(true);
        }

        if start < theme.end {
            return fail(
                "Theme references must follow their local definition.",
                node.span(),
            );
        }

        if let AstKind::CallExpression(call) = parent
            && self.factories.contains(&call.span.start)
            && call
                .arguments
                .first()
                .is_some_and(|argument| is(node, argument))
        {
            return Ok(true);
        }

        let member = Member::of_kind(parent).filter(|member| is(node, member.object));

        if let Some(member) = member {
            let named = |name: &str| match member.property {
                Property::Identifier(property) if !member.computed => property == name,
                Property::Literal(literal) if member.computed => {
                    literal_string(literal).as_deref() == Some(name)
                }
                _ => false,
            };

            if theme.direct_variables || named("tokens") || named("vars") {
                return self.token_reference(node, parent, member, ancestors, theme);
            }
        }

        let Some(member) = member.filter(|member| !member.computed && !member.optional) else {
            return fail(
                "Use Config.create or Vars.extend with variable definitions; other references require source linking.",
                node.span(),
            );
        };
        let Property::Identifier(property) = member.property else {
            return fail(
                "Use Config.create or Vars.extend with variable definitions; other references require source linking.",
                node.span(),
            );
        };

        if matches!(property, "style" | "variants")
            && let Some(AstKind::CallExpression(call)) = grandparent
            && is(parent, &call.callee)
            && !call.optional
        {
            let definition = self.theme(&theme.name)?;

            self.styles.insert(
                call.span.start,
                StyleCall {
                    base_ui: theme.base_ui,
                    call,
                    output: theme.output,
                    recipe: property == "variants",
                    theme: definition,
                },
            );

            return Ok(true);
        }

        if property != "className" {
            return fail(
                "Only direct theme.style calls and theme.className reads are supported here.",
                parent.span(),
            );
        }

        let mut target = parent;
        let mut index = signed(length) - 3;

        while let Some(ancestor) = at(index) {
            if assigns(ancestor, target) {
                return fail(
                    "Theme scope properties cannot be reassigned.",
                    ancestor.span(),
                );
            }

            if wrapped(ancestor).is_some_and(|expression| is(target, expression))
                || property_value(ancestor).is_some_and(|value| value == target.address())
                || matches!(
                    ancestor,
                    AstKind::ObjectPattern(_)
                        | AstKind::ArrayPattern(_)
                        | AstKind::ObjectAssignmentTarget(_)
                        | AstKind::ArrayAssignmentTarget(_)
                )
                || rest_argument(ancestor).is_some_and(|argument| argument == target.address())
                || default_target(ancestor).is_some_and(|left| left == target.address())
            {
                target = ancestor;
                index -= 1;
            } else {
                break;
            }
        }

        self.references.push(Reference {
            end: member.span.end,
            name: Arc::clone(&theme.name),
            start: member.span.start,
        });

        Ok(true)
    }

    /// Resolves a token path read through `tokens`, `vars`, or a variable set's references.
    fn token_reference(
        &mut self,
        node: AstKind<'a>,
        parent: AstKind<'a>,
        member: Member<'a, 'a>,
        ancestors: &[AstKind<'a>],
        theme: &Call,
    ) -> Result<bool> {
        let at = |index: isize| {
            usize::try_from(index)
                .ok()
                .and_then(|index| ancestors.get(index))
                .copied()
        };
        let length = isize::try_from(ancestors.len()).unwrap_or(isize::MAX);

        if member.optional {
            return fail(
                "Token references cannot use optional access.",
                parent.span(),
            );
        }

        let variable = theme.direct_variables
            || match member.property {
                Property::Identifier(name) => name == "vars",
                Property::Literal(Expression::StringLiteral(literal)) => literal.value == "vars",
                _ => false,
            };
        let definition = self.theme(&theme.name)?;
        let mut value = if variable && !theme.direct_variables {
            definition.vars.clone()
        } else {
            definition.tokens.clone()
        };
        let mut target = if theme.direct_variables { node } else { parent };
        let mut index = length - if theme.direct_variables { 2 } else { 3 };

        while let Some(ancestor) = at(index) {
            let Some(member) = Member::of_kind(ancestor) else {
                break;
            };

            if !is(target, member.object) {
                break;
            }

            let key = member.key();
            let Some(key) = key.filter(|_| !member.optional) else {
                return fail(
                    "Token paths require static property names without optional access.",
                    ancestor.span(),
                );
            };

            value = match &value {
                Data::Token(_) => Data::Undefined,
                value => own_property(value, &key),
            };

            if value.is_undefined() {
                return fail("Unknown theme token path.", ancestor.span());
            }

            target = ancestor;
            index -= 1;
        }

        let Data::Token(reference) = value else {
            return fail("Expected a scalar theme token reference.", target.span());
        };

        while let Some(ancestor) = at(index) {
            if wrapped(ancestor).is_some_and(|expression| is(target, expression)) {
                target = ancestor;
                index -= 1;
            } else {
                break;
            }
        }

        let value_target = target;

        if variable {
            while let Some(ancestor) = at(index) {
                let interpolated = matches!(ancestor, AstKind::TemplateLiteral(template)
                    if template.expressions.iter().any(|expression| is(target, expression)));

                if !interpolated
                    && !wrapped(ancestor).is_some_and(|expression| is(target, expression))
                {
                    break;
                }

                target = ancestor;
                index -= 1;
            }
        }

        if let Some(AstKind::ArrayExpression(array)) = at(index)
            && array.elements.iter().any(|element| {
                element
                    .as_expression()
                    .is_some_and(|element| is(target, element))
            })
        {
            target = AstKind::ArrayExpression(array);
            index -= 1;

            while let Some(ancestor) = at(index) {
                if wrapped(ancestor).is_some_and(|expression| is(target, expression)) {
                    target = ancestor;
                    index -= 1;
                } else {
                    break;
                }
            }
        }

        let property = at(index);
        let object = at(index - 1);
        let mut argument = object;
        let mut call_index = index - 2;

        while let Some(ancestor) = at(call_index) {
            if let AstKind::ObjectProperty(entry) = ancestor
                && argument.is_some_and(|argument| is(argument, &entry.value))
                && matches!(at(call_index - 1), Some(AstKind::ObjectExpression(_)))
            {
                call_index -= 1;
                argument = at(call_index);
                call_index -= 1;
                continue;
            }

            if argument.is_some_and(|argument| {
                wrapped(ancestor).is_some_and(|expression| is(argument, expression))
            }) {
                argument = Some(ancestor);
                call_index -= 1;
            } else {
                break;
            }
        }

        if let Some(AstKind::ArrowFunctionExpression(arrow)) = at(call_index)
            && argument.is_some_and(|argument| {
                arrow_expression(arrow).is_some_and(|body| is(argument, body))
            })
        {
            argument = at(call_index);
            call_index -= 1;
        }

        while let Some(wrapper) = at(call_index) {
            if argument.is_some_and(|argument| {
                wrapped(wrapper).is_some_and(|expression| is(argument, expression))
            }) {
                argument = Some(wrapper);
                call_index -= 1;
            } else {
                break;
            }
        }

        let call = at(call_index);
        let direct = matches!(property, Some(AstKind::ObjectProperty(entry)) if is(target, &entry.value))
            && matches!(object, Some(AstKind::ObjectExpression(_)))
            && matches!(call, Some(AstKind::CallExpression(call))
                if call.arguments.first().is_some_and(|first| argument.is_some_and(|argument| is(argument, first)))
                    && (self.styles.contains_key(&call.span.start)
                        || self.options.contribution_calls.contains(&call.span.start)));

        if !direct {
            let bound = ancestors.iter().any(|node| {
                matches!(node, AstKind::VariableDeclarator(declarator)
                    if self.options.static_bindings.contains(&declarator.span.start))
            });

            if !bound {
                return fail(
                    "Token references must be direct property values in bound theme style calls.",
                    target.span(),
                );
            }

            let span = value_target.span();

            self.static_tokens.push(StaticToken {
                end: span.end,
                start: span.start,
                value_start: unwrapped(value_target).start,
            });
        }

        let span = value_target.span();

        self.tokens.insert(
            span.start,
            TokenRead {
                end: span.end,
                reference: Arc::clone(&reference),
            },
        );

        let inner = unwrapped(value_target);

        self.tokens.insert(
            inner.start,
            TokenRead {
                end: inner.end,
                reference,
            },
        );

        Ok(true)
    }

    /// Native alternatives of the contract a style call or its token reads use.
    ///
    /// # Errors
    ///
    /// Returns theme and variable-set errors from defining catalog alternatives of an alias.
    pub fn native_context(&mut self, start: u32, end: u32) -> Result<Option<NativeContext>> {
        let contract = match self.styles.get(&start) {
            Some(style) => Some(Arc::clone(&style.theme.metadata.contract)),
            None => self
                .tokens
                .iter()
                .find(|(offset, _)| **offset >= start && **offset < end)
                .map(|(_, token)| Arc::clone(&token.reference.contract)),
        };
        let Some(contract) = contract else {
            return Ok(None);
        };

        if let Some((_, cached)) = self
            .native_contexts
            .iter()
            .find(|(candidate, _)| Arc::ptr_eq(candidate, &contract))
        {
            return Ok(Some(cached.clone()));
        }

        let config = self
            .configs
            .values()
            .find(|value| Arc::ptr_eq(&value.definition.metadata.contract, &contract));
        let context =
            if let Some(config) = config.filter(|config| option_truthy(&config.call, "themes")) {
                let mut vars: Record<Arc<Definition>> = Record::new();

                for (key, value) in config.members.iter().flat_map(Record::iter) {
                    let path = member_path(key);

                    match path.as_slice() {
                        [name] if config.call.selection => {
                            vars.insert(name.as_str(), Arc::clone(&value.definition));
                        }
                        [first, name] if first == "themes" || first == "vars" => {
                            vars.insert(name.as_str(), Arc::clone(&value.definition));
                        }
                        _ => {}
                    }
                }

                NativeContext {
                    default_vars: option_string(&config.call, "defaultTheme"),
                    vars,
                }
            } else {
                let alias = self.alias_names.values().find(|value| {
                    self.themes
                        .get(&value.call.name)
                        .is_some_and(|theme| Arc::ptr_eq(&theme.metadata.contract, &contract))
                        && option_truthy(&value.call, "themes")
                });
                let Some(alias) = alias else {
                    return Ok(None);
                };
                let mut vars: Record<Arc<Definition>> = Record::new();
                let themes = alias
                    .call
                    .options
                    .as_ref()
                    .and_then(|options| options.get("themes"))
                    .and_then(Data::as_object)
                    .cloned()
                    .unwrap_or_default();

                for (name, values) in themes.iter() {
                    let original = if contract.variable_set {
                        variable_sets::theme(&vars::define(values, None, None)?, None)?
                    } else {
                        theme::define(values, None)?
                    };

                    vars.insert(
                        Arc::clone(name),
                        Arc::new(token::bind(&original, &contract, None)?),
                    );
                }

                NativeContext {
                    default_vars: option_string(&alias.call, "defaultTheme"),
                    vars,
                }
            };

        self.native_contexts.push((contract, context.clone()));

        Ok(Some(context))
    }
}

/// `html` when a call's options configure HTML output.
fn html(call: &Call) -> Option<Output> {
    call.options
        .as_ref()
        .and_then(|options| options.get("output"))
        .and_then(Data::as_str)
        .filter(|output| *output == "html")
        .map(|_| Output::Html)
}

/// Spells an option like `String(value)`.
fn option_string(call: &Call, key: &str) -> Arc<str> {
    call.options
        .as_ref()
        .and_then(|options| options.get(key))
        .map_or_else(
            || Arc::from("undefined"),
            |value| value.to_js_string().into(),
        )
}

/// The span of a node beneath TypeScript wrappers.
fn unwrapped(node: AstKind<'_>) -> Span {
    match wrapped(node) {
        Some(expression) => expression::unwrap(expression).span(),
        None => node.span(),
    }
}

/// Whether an ancestor writes to `target` or deletes a property.
fn assigns(ancestor: AstKind<'_>, target: AstKind<'_>) -> bool {
    match ancestor {
        AstKind::AssignmentExpression(assignment) => is(target, &assignment.left),
        AstKind::UpdateExpression(update) => is(target, &update.argument),
        AstKind::UnaryExpression(unary) => unary.operator == UnaryOperator::Delete,
        AstKind::ForInStatement(statement) => is(target, &statement.left),
        AstKind::ForOfStatement(statement) => is(target, &statement.left),
        _ => false,
    }
}

/// The value address of an ESTree `Property`: object properties and destructuring properties.
fn property_value(ancestor: AstKind<'_>) -> Option<Address> {
    match ancestor {
        AstKind::ObjectProperty(property) => Some(property.value.address()),
        AstKind::BindingProperty(property) => Some(property.value.address()),
        AstKind::AssignmentTargetPropertyProperty(property) => Some(property.binding.address()),
        _ => None,
    }
}

/// The argument address of an ESTree `RestElement`.
fn rest_argument(ancestor: AstKind<'_>) -> Option<Address> {
    match ancestor {
        AstKind::AssignmentTargetRest(rest) => Some(rest.target.address()),
        AstKind::BindingRestElement(rest) => Some(rest.argument.address()),
        _ => None,
    }
}

/// The left address of an ESTree `AssignmentPattern`.
fn default_target(ancestor: AstKind<'_>) -> Option<Address> {
    match ancestor {
        AstKind::AssignmentTargetWithDefault(pattern) => Some(pattern.binding.address()),
        AstKind::AssignmentPattern(pattern) => Some(pattern.left.address()),
        _ => None,
    }
}
