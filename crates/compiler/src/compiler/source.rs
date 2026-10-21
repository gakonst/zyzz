//! Extracts literal styles and local themes through lexical source analysis.
//!
//! [`Extracted`] is the contract later stages share: the direct definition calls a rewriter
//! replaces, validated style definitions, and the theme, variable, and stylesheet data of one
//! module. Offsets in extraction results are UTF-8 byte offsets into the module source, and hosts
//! convert them to UTF-16 at the JSON boundary. Diagnostics report UTF-16 offsets, as the public
//! error does.

use std::borrow::Cow;
use std::cell::RefCell;
use std::sync::Arc;

use indexmap::IndexMap;
use lightningcss::rules::CssRule;
use lightningcss::values::url::Url;
use lightningcss::visitor::{Visit as _, VisitTypes, Visitor};
use oxc_allocator::{Allocator, CloneIn, GetAddress, UnstableAddress, Vec as ArenaVec};
use oxc_ast::AstKind;
use oxc_ast::ast::{
    Argument, ArrayExpressionElement, BindingPattern, CallExpression, Expression,
    ImportDeclarationSpecifier, ObjectExpression, ObjectPropertyKind, PropertyKey, PropertyKind,
    Statement, TemplateLiteral, UnaryOperator,
};
use oxc_ast::builder::AstBuilder;
use oxc_ast_visit::Visit;
use oxc_semantic::NodeId;
use oxc_span::{GetSpan, Span};
use rustc_hash::{FxBuildHasher, FxHashMap, FxHashSet};
use smallvec::SmallVec;

use crate::compiler::internal::dynamic::{self, Slots};
use crate::compiler::internal::expression::{self, Template, unwrap};
use crate::compiler::internal::lightning::Options as Transform;
use crate::compiler::internal::scope::{self, Declaration, Mode};
use crate::compiler::internal::statics::{self, Static};
use crate::compiler::internal::syntax::{self, Parsed};
use crate::compiler::internal::themes::{self, Alias, Context, Link, Output, Themes, VarsRead};
use crate::compiler::internal::vars::{self, Variables};
use crate::compiler::internal::{
    at_rules, base_ui, compositions, contributions, identifiers, names, packed_styles,
    recipe_payloads, recipes, selectors,
};
use crate::data::{Data, Object};
use crate::error::{Error, Result};
use crate::generated::literal::Kind as LiteralKind;
use crate::internal::binding::{self, Domain};
use crate::internal::theme::Definition;
use crate::internal::token::{self, Part};
use crate::internal::{condition, identity, literal, recipe, rule_reference, typography, value};
use crate::js::{self, Record, Utf16Index};
use crate::runtime::composition::Owner;
use crate::runtime::recipe as runtime;
use crate::style::{self, NamedStyle, SourceLocation};
use crate::web::css;
use crate::web::internal::themes::{self as web_themes, Scope};
use crate::web::internal::{contributions as web, namespace};

#[cold]
fn invalid(message: &str, span: Span) -> Error {
    Error::Themes {
        message: message.to_owned(),
        span,
    }
}

/// Native alternatives of an authoring contract.
#[derive(Clone, Debug, PartialEq)]
pub struct NativeContext {
    /// Default label selected when the provider omits its theme.
    pub default_vars: Arc<str>,
    /// Compatible alternatives from the owning configuration.
    pub vars: Record<Arc<Definition>>,
}

/// One input of a runtime composition.
#[derive(Clone, Debug)]
pub struct RuntimeInput {
    /// Start of the original resolved application, for selective HTML preparation.
    pub application_start: Option<u32>,
    /// Presence bit of a conditional argument.
    pub condition: Option<u32>,
    /// Exclusive offset of the application argument.
    pub end: u32,
    /// Reads of a no-argument application whose props the compiler knows.
    pub known: Option<KnownInput>,
    /// Replaced generated class owner.
    pub name: Arc<str>,
    /// Attribute and private variable ownership.
    pub owners: Vec<Owner>,
    /// Inclusive offset of the application argument.
    pub start: u32,
}

/// The reads a statically known composition argument keeps once its application is skipped.
#[derive(Clone, Debug)]
pub struct KnownInput {
    /// Authored callee, read for truthiness so initialization failures still throw.
    pub callee: Arc<str>,
    /// Left operand of a conditional `&&` argument.
    pub condition: Option<Span>,
    /// Whether the definition is imported, so its class list may be unknown to this module.
    pub imported: bool,
}

/// A definition call available for a later source rewriter.
///
/// Offsets are UTF-8 byte offsets into the module source. Public results convert them to UTF-16.
#[derive(Clone, Debug, Default)]
pub struct Call<'a> {
    /// Expanded literal body retained for declaration mapping.
    pub body: Option<&'a ObjectExpression<'a>>,
    /// Binding reads preserved by compile-time composition.
    pub composition: Option<Vec<Arc<str>>>,
    /// Whether the call is a CSS-only presence alternative of a runtime composition.
    pub composition_case: bool,
    /// Names of precompiled presence alternatives in bitmask order.
    pub composition_cases: Option<Vec<Arc<str>>>,
    /// Readable authored binding for contextual CSS names.
    pub css_name: Option<Arc<str>>,
    /// Configuration namespace for emitted CSS.
    pub css_namespace: Option<Arc<str>>,
    /// Ordered dynamic alternatives with scalar binding references.
    pub dynamic_recipe: Option<recipe::Definition>,
    /// Exclusive offset of the complete call.
    pub end: u32,
    /// Stable selector identity.
    pub identity: Option<Arc<str>>,
    /// Fields of a callback definition whose type admits a CSS-wide keyword.
    pub keywords: Vec<Arc<str>>,
    /// Name of the definition in the extracted styles.
    pub name: Arc<str>,
    /// Native alternatives of the authoring contract.
    pub native_context: Option<NativeContext>,
    /// HTML attribute output.
    pub output: Option<Output>,
    /// Ownership retained by a separately compiled callable.
    pub ownership: Option<Owner>,
    /// Class identity available without source rewriting.
    pub portable: Option<Arc<str>>,
    /// Flattened definition identities of nested compositions.
    pub portable_inputs: Option<Vec<Arc<str>>>,
    /// Finite recipe selection metadata.
    pub recipe: Option<runtime::Definition>,
    /// Typed payload signatures by axis and choice.
    pub recipe_types: Option<Record<Record<Arc<str>>>>,
    /// Fixed runtime applications over a resolved CSS sequence.
    pub runtime_composition: Option<Vec<RuntimeInput>>,
    /// Alias targets for declaration source locations.
    pub shorthands: Option<crate::internal::token::Map<Arc<[Arc<str>]>>>,
    /// Typed runtime slots of a callback definition.
    pub slots: Option<Slots>,
    /// Inclusive offset of the complete call.
    pub start: u32,
    /// Ordered static alternatives without selector lowering.
    pub static_recipe: Option<recipe::Definition>,
    /// Emitted typography field counts by authored property offset.
    pub typography: Option<FxHashMap<u32, u32>>,
    /// Emitted typography query counts by authored property offset.
    pub typography_queries: Option<FxHashMap<u32, u32>>,
    /// Authored scalar input type text.
    pub values_type: Option<Arc<str>>,
}

/// The stable category of a source diagnostic.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Code {
    /// A literal failed style validation.
    InvalidLiteral,
    /// The module identity is not portable.
    InvalidModule,
    /// The module does not parse.
    SyntaxError,
    /// Source syntax outside the supported static boundary.
    UnsupportedSyntax,
}

impl Code {
    /// The TypeScript spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidLiteral => "invalid_literal",
            Self::InvalidModule => "invalid_module",
            Self::SyntaxError => "syntax_error",
            Self::UnsupportedSyntax => "unsupported_syntax",
        }
    }
}

/// A source-owned extraction failure.
#[derive(Clone, Debug, PartialEq)]
pub struct Diagnostic {
    /// Stable failure category.
    pub code: Code,
    /// Exclusive UTF-16 source offset.
    pub end: u32,
    /// Explanation of the supported input boundary.
    pub message: String,
    /// Portable module identity supplied by the host.
    pub source: Arc<str>,
    /// Inclusive UTF-16 source offset.
    pub start: u32,
}

/// `Source.ExtractError`: every source diagnostic of a failed extraction, in source order.
#[derive(Clone, Debug, PartialEq)]
pub struct ExtractError {
    /// Diagnostics, stably sorted by start offset.
    pub diagnostics: Vec<Diagnostic>,
}

impl ExtractError {
    /// Orders diagnostics by start offset, keeping report order for equal starts.
    pub fn new(mut diagnostics: Vec<Diagnostic>) -> Self {
        diagnostics.sort_by_key(|diagnostic| diagnostic.start);

        Self { diagnostics }
    }

    /// The error message: one `source:start: message` line per diagnostic.
    pub fn message(&self) -> String {
        let mut output = String::new();

        for (index, diagnostic) in self.diagnostics.iter().enumerate() {
            if index > 0 {
                output.push('\n');
            }

            output.push_str(&diagnostic.source);
            output.push(':');
            output.push_str(&diagnostic.start.to_string());
            output.push_str(": ");
            output.push_str(&diagnostic.message);
        }

        output
    }
}

/// A scope read in a static binding, replaced by its serialized class constant.
#[derive(Clone, Debug, PartialEq)]
pub struct StaticThemeReference {
    /// Exclusive offset of the read.
    pub end: u32,
    /// Inclusive offset of the read.
    pub start: u32,
    /// Serialized CSS value.
    pub value: String,
}

/// The target whose authoring semantics extraction applies.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Target {
    /// React Native: applications keep native props composition.
    Native,
    /// The web.
    #[default]
    Web,
}

/// Source text and identity supplied by an adapter.
#[derive(Clone, Copy)]
pub struct Options<'s, 'a> {
    /// `Some(false)` collects portable runtime identities when source rewriting is disabled.
    pub compiler: Option<bool>,
    /// Compiler-owned graph context.
    pub context: Option<&'s Context<'a>>,
    /// Portable identity including package and module path; no filesystem access occurs.
    pub module_id: &'s str,
    /// Syntax owned by the current graph compilation, parsed from `source`.
    pub parsed: Option<&'s Parsed<'a>>,
    /// Complete module text, parsed as TypeScript with JSX.
    pub source: &'a str,
    /// Target semantics.
    pub target: Target,
}

/// Ordered compiler input and rewrite spans of one module.
///
/// Empty lists stand for the optional TypeScript fields, which are absent when empty.
pub struct Extracted<'a> {
    /// Direct calls in source order.
    pub calls: Vec<Call<'a>>,
    /// Whether theme collection ran, which needs a theme factory import or graph links.
    pub collected_themes: bool,
    /// Stylesheet factory calls and their source replacements.
    pub contribution_calls: Vec<contributions::Call<'a>>,
    /// Call starts of each contribution, in contribution order.
    pub contribution_starts: Vec<u32>,
    /// Static stylesheet effects.
    pub contributions: Vec<web::Definition>,
    /// Module-owned namespace bindings retained when contributions are shared.
    pub namespaces: Vec<namespace::Definition>,
    /// Readonly native variable arguments and their complete catalogs.
    pub native_vars: Vec<VarsRead>,
    /// Scope reads replaced by class constants.
    pub static_theme_references: Vec<StaticThemeReference>,
    /// Validated definitions accepted by `Css.compile`, with readable class labels.
    pub styles: style::Definition,
    /// Local bound-authoring initializers and their retained token types.
    pub theme_aliases: Vec<Alias>,
    /// Configuration identities retaining their root controls.
    pub theme_appearances: Vec<Arc<str>>,
    /// Local factory spans replaced by compiled scope data.
    pub theme_calls: Vec<themes::Call>,
    /// Resolved authoring exports, present when extracted as part of a source graph.
    pub theme_exports: Option<Record<Link>>,
    /// Theme `className` reads replaced with compiled constants.
    pub theme_references: Vec<themes::Reference>,
    /// Configuration identities retaining their initialization helper.
    pub theme_scripts: Vec<Arc<str>>,
    /// Configuration identities whose theme selector is called, passed, or bound.
    pub theme_selections: Vec<Arc<str>>,
    /// Explicit variable contracts replaced by fixed slot data.
    pub variable_calls: Vec<vars::Call>,
    /// Stable scope keys and validated local theme definitions.
    pub vars: Record<Arc<Definition>>,
}

/// Collects diagnostics with UTF-16 offsets.
struct Reporter<'p> {
    diagnostics: Vec<Diagnostic>,
    module_id: Arc<str>,
    offsets: &'p Utf16Index,
}

impl Reporter<'_> {
    /// Reports a diagnostic at a UTF-8 span, or at offset zero without one.
    fn report(&mut self, code: Code, message: impl Into<String>, span: Option<Span>) {
        let (start, end) = span.map_or((0, 0), |span| {
            (self.offsets.utf16(span.start), self.offsets.utf16(span.end))
        });

        self.diagnostics.push(Diagnostic {
            code,
            end,
            message: message.into(),
            source: Arc::clone(&self.module_id),
            start,
        });
    }

    /// Reports `Source.ThemeInvalidError` as unsupported syntax and passes other errors on.
    fn unsupported(&mut self, error: Error) -> Result<()> {
        match error {
            Error::Themes { message, span } => {
                self.report(Code::UnsupportedSyntax, message, Some(span));
                Ok(())
            }
            error => Err(error),
        }
    }

    fn len(&self) -> usize {
        self.diagnostics.len()
    }

    fn fail(&mut self) -> Error {
        Error::Extract(ExtractError::new(std::mem::take(&mut self.diagnostics)))
    }
}

/// Whether a node is a type subtree the extraction walk skips.
fn type_node(kind: AstKind<'_>, parent: Option<AstKind<'_>>) -> bool {
    let annotation = match parent {
        Some(AstKind::TSAsExpression(parent)) => Some(&parent.expression),
        Some(AstKind::TSSatisfiesExpression(parent)) => Some(&parent.expression),
        Some(AstKind::TSTypeAssertion(parent)) => Some(&parent.expression),
        _ => None,
    }
    .is_some_and(|expression: &Expression<'_>| expression.address() != kind.address());

    annotation
        || matches!(
            kind,
            AstKind::TSInterfaceDeclaration(_)
                | AstKind::TSTypeAliasDeclaration(_)
                | AstKind::TSTypeAnnotation(_)
                | AstKind::TSTypeParameterDeclaration(_)
                | AstKind::TSTypeParameterInstantiation(_)
                | AstKind::TSTypeQuery(_)
                | AstKind::ExportFromDeclaration(_)
        )
        || matches!(kind, AstKind::ExportNamedDeclaration(export) if export.export_kind.is_type())
        || matches!(kind, AstKind::ExportSpecifier(specifier) if specifier.export_kind.is_type())
}

/// Authoring names a namespace import cannot call.
const NAMESPACE_AUTHORING: [&str; 10] = [
    "Config",
    "cx",
    "defineConfig",
    "defineVars",
    "extendVars",
    "style",
    "Theme",
    "Vars",
    "variable",
    "variants",
];

/// The identifier walk: theme, variable, and stylesheet reads, and direct `style` calls.
struct Walker<'w, 'p, 'a> {
    ancestors: Vec<AstKind<'a>>,
    contributions: &'w mut contributions::Contributions<'a>,
    fatal: Option<Error>,
    parsed: &'w Parsed<'a>,
    pending: Vec<&'a CallExpression<'a>>,
    recipes: FxHashSet<u32>,
    reporter: &'w mut Reporter<'p>,
    themes: Option<&'w mut Themes<'a>>,
    /// The identifier being read.
    node: NodeId,
    variables: &'w Variables<'a>,
}

impl<'a> Walker<'_, '_, 'a> {
    /// Reads every identifier in entry order with the ancestors a full walk would have entered.
    /// The semantic node list holds nodes in that order with parent links, so only identifiers
    /// are visited.
    fn scan(&mut self) {
        let nodes = self.parsed.semantic.nodes();

        for node in nodes.iter() {
            let kind = node.kind();

            if !matches!(
                kind,
                AstKind::IdentifierReference(_) | AstKind::BindingIdentifier(_)
            ) {
                continue;
            }

            // A failure ends reading; later nodes would only be entered.
            if self.fatal.is_some() {
                break;
            }

            let parent =
                (nodes.parent_id(node.id()) != node.id()).then(|| nodes.parent_kind(node.id()));

            self.node = node.id();
            self.ancestors.clear();

            if let Err(error) = self.read(kind, parent) {
                self.fatal = Some(error);
            }
        }
    }

    /// Whether a type subtree encloses the identifier being read. Ancestors run innermost first,
    /// and each one's parent follows it.
    fn typed(&self, kind: AstKind<'a>) -> bool {
        let mut child = kind;

        for ancestor in self.parsed.semantic.nodes().ancestor_kinds(self.node) {
            if type_node(child, Some(ancestor)) {
                return true;
            }

            child = ancestor;
        }

        type_node(child, None)
    }

    /// Fills the current identifier's ancestors, outermost first and ending with it, for the
    /// readers that inspect them.
    fn chain(&mut self, kind: AstKind<'a>) {
        if self.ancestors.is_empty() {
            self.ancestors
                .extend(self.parsed.semantic.nodes().ancestor_kinds(self.node));
            self.ancestors.reverse();
            self.ancestors.push(kind);
        }
    }

    fn read(&mut self, kind: AstKind<'a>, parent: Option<AstKind<'a>>) -> Result<()> {
        let semantic = &self.parsed.semantic;
        let lookup = |name: &str| {
            scope::lookup(
                semantic,
                name,
                scope::scope_of(semantic, kind.node_id()),
                Mode::Value,
            )
        };
        let binding: Option<Declaration<'a>> = match kind {
            AstKind::IdentifierReference(identifier) => match parent {
                Some(
                    AstKind::TSTypeReference(_)
                    | AstKind::TSQualifiedName(_)
                    | AstKind::TSClassImplements(_)
                    | AstKind::TSInterfaceHeritage(_),
                ) => return Ok(()),
                // ESTree reads JSX element names as `JSXIdentifier`, resolved by name.
                Some(
                    AstKind::JSXOpeningElement(_)
                    | AstKind::JSXClosingElement(_)
                    | AstKind::JSXMemberExpression(_),
                ) => lookup(&identifier.name),
                _ => scope::resolve(semantic, identifier),
            },
            AstKind::BindingIdentifier(identifier) => {
                let nested = match parent {
                    Some(
                        AstKind::BindingProperty(_)
                        | AstKind::ArrayPattern(_)
                        | AstKind::AssignmentPattern(_)
                        | AstKind::BindingRestElement(_),
                    ) => true,
                    Some(AstKind::FormalParameter(parameter)) => {
                        parameter.initializer.is_some()
                            && matches!(parameter.pattern, BindingPattern::BindingIdentifier(_))
                    }
                    _ => false,
                };

                if !nested {
                    return Ok(());
                }

                lookup(&identifier.name)
            }
            _ => return Ok(()),
        };

        // Both passes visit identical scopes; skipping type subtrees changes scope IDs.
        if self.typed(kind) {
            return Ok(());
        }

        self.contributions.read(kind, parent, binding.as_ref());

        let zyzz = binding
            .as_ref()
            .and_then(|binding| binding.import)
            .is_some_and(|import| {
                matches!(import.source.value.as_str(), "zyzz" | "zyzz/base-ui/react")
            });

        if zyzz || self.themes.is_some() || self.variables.declares() {
            self.chain(kind);
        }

        match self
            .variables
            .reference(kind, &self.ancestors, binding.as_ref())
        {
            Ok(true) => return Ok(()),
            Ok(false) => {}
            Err(error) => return self.reporter.unsupported(error),
        }

        if let Some(themes) = self.themes.as_deref_mut() {
            match themes.reference(kind, &self.ancestors, binding.as_ref(), &lookup) {
                Ok(true) => return Ok(()),
                Ok(false) => {}
                Err(error) => return self.reporter.unsupported(error),
            }
        }

        let Some(binding) = binding else {
            return Ok(());
        };
        let Some(import) = binding.import.filter(|import| {
            binding.kind == scope::Kind::Import
                && matches!(import.source.value.as_str(), "zyzz" | "zyzz/base-ui/react")
                && !import.import_kind.is_type()
        }) else {
            return Ok(());
        };
        let Some(specifier) = import
            .specifiers
            .iter()
            .flatten()
            .find(|specifier| specifier.span().start == binding.start())
        else {
            return Ok(());
        };

        match specifier {
            ImportDeclarationSpecifier::ImportNamespaceSpecifier(_) => {
                let name = match parent {
                    Some(AstKind::StaticMemberExpression(member))
                        if member.object.address() == kind.address() =>
                    {
                        Some(member.property.name.as_str())
                    }
                    Some(AstKind::ComputedMemberExpression(member))
                        if member.object.address() == kind.address() =>
                    {
                        match &member.expression {
                            Expression::StringLiteral(literal) => Some(literal.value.as_str()),
                            _ => None,
                        }
                    }
                    _ => None,
                };

                if let (Some(name), Some(parent)) = (name, parent)
                    && NAMESPACE_AUTHORING.contains(&name)
                {
                    self.reporter.report(
                        Code::UnsupportedSyntax,
                        format!(
                            "Import {name} by name; namespace authoring calls are not supported yet."
                        ),
                        Some(parent.span()),
                    );
                }

                Ok(())
            }
            ImportDeclarationSpecifier::ImportSpecifier(specifier)
                if !specifier.import_kind.is_type()
                    && matches!(specifier.imported.name().as_str(), "style" | "variants") =>
            {
                self.style(kind, parent, specifier.imported.name() == "variants");

                Ok(())
            }
            _ => Ok(()),
        }
    }

    /// Records a direct `style` or `variants` call, rejecting writes and indirect reads.
    fn style(&mut self, kind: AstKind<'a>, parent: Option<AstKind<'a>>, recipe: bool) {
        // Follow only assignment targets; computed keys and default values are reads.
        let mut target = kind.address();
        let mut write = None;

        for ancestor in self.ancestors.iter().rev().skip(1) {
            let assigned = match ancestor {
                AstKind::AssignmentExpression(assignment) => assignment.left.address() == target,
                AstKind::UpdateExpression(update) => update.argument.address() == target,
                AstKind::ForInStatement(statement) => statement.left.address() == target,
                AstKind::ForOfStatement(statement) => statement.left.address() == target,
                _ => false,
            };

            if assigned {
                write = Some(ancestor.span());
                break;
            }

            let pattern = match ancestor {
                AstKind::ObjectProperty(property) => property.value.address() == target,
                AstKind::BindingProperty(property) => property.value.address() == target,
                AstKind::AssignmentTargetPropertyProperty(property) => {
                    property.binding.address() == target
                }
                AstKind::AssignmentTargetPropertyIdentifier(property) => {
                    property.binding.unstable_address() == target
                }
                AstKind::ObjectPattern(_)
                | AstKind::ArrayPattern(_)
                | AstKind::ObjectAssignmentTarget(_)
                | AstKind::ArrayAssignmentTarget(_) => true,
                AstKind::BindingRestElement(rest) => rest.argument.address() == target,
                AstKind::AssignmentTargetRest(rest) => rest.target.address() == target,
                AstKind::AssignmentPattern(pattern) => pattern.left.address() == target,
                AstKind::AssignmentTargetWithDefault(pattern) => {
                    pattern.binding.address() == target
                }
                _ => false,
            };

            if !pattern {
                break;
            }

            target = ancestor.address();
        }

        if let Some(write) = write {
            self.reporter.report(
                Code::UnsupportedSyntax,
                "Imported style bindings cannot be reassigned.",
                Some(write),
            );
            return;
        }

        if let Some(AstKind::CallExpression(call)) = parent
            && call.callee.address() == kind.address()
            && !call.optional
        {
            self.pending.push(call);

            if recipe {
                self.recipes.insert(call.span.start);
            }

            return;
        }

        self.reporter.report(
            Code::UnsupportedSyntax,
            "Use a direct style call; aliases, re-exports, and indirect references are not supported yet.",
            Some(kind.span()),
        );
    }
}

/// Whether an expression is an object of uncomputed keys whose values are all string or numeric
/// literals.
fn flat(value: &Expression<'_>) -> bool {
    let Expression::ObjectExpression(object) = value else {
        return false;
    };

    object.properties.iter().all(|property| {
        matches!(property, ObjectPropertyKind::ObjectProperty(property)
        if !property.computed
            && matches!(
                property.value,
                Expression::StringLiteral(_) | Expression::NumericLiteral(_)
            ))
    })
}

/// Collects the key starts of properties inside `selectors` objects.
struct SelectorKeys<'k> {
    keys: &'k mut FxHashSet<u32>,
}

impl<'a> Visit<'a> for SelectorKeys<'_> {
    fn enter_node(&mut self, kind: AstKind<'a>) {
        let AstKind::ObjectProperty(property) = kind else {
            return;
        };
        let named = match &property.key {
            PropertyKey::StaticIdentifier(key) => key.name == "selectors",
            PropertyKey::StringLiteral(key) => key.value == "selectors",
            _ => false,
        };
        let Expression::ObjectExpression(object) = &property.value else {
            return;
        };

        if property.computed || !named {
            return;
        }

        for entry in &object.properties {
            if let ObjectPropertyKind::ObjectProperty(entry) = entry {
                self.keys.insert(entry.key.span().start);
            }
        }
    }
}

/// Dynamic slots of a typed callback or of recipe payload contexts.
#[derive(Clone, Copy)]
enum Bindings<'d, 'a> {
    Payloads(&'d recipe_payloads::Payloads<'d, 'a>),
    Read(&'d dynamic::Read<'a>),
}

impl<'a> Bindings<'_, 'a> {
    fn resolve(&self, node: &Expression<'a>) -> Result<Option<Arc<binding::Reference>>> {
        match self {
            Self::Payloads(payloads) => Ok(payloads.resolve(node)),
            Self::Read(read) => read.resolve(node),
        }
    }

    fn accepts(&self, reference: &binding::Reference, property: &str) -> bool {
        match self {
            Self::Payloads(payloads) => payloads.accepts(reference, property),
            Self::Read(read) => read.accepts(reference, property),
        }
    }

    /// Whether a reference is one of these slots, by identity.
    fn contains(&self, reference: &Arc<binding::Reference>) -> bool {
        let slots = match self {
            Self::Payloads(payloads) => &payloads.slots,
            Self::Read(read) => &read.slots,
        };

        slots.values().any(|slot| Arc::ptr_eq(slot, reference))
    }
}

/// A token or variable read that a declaration value names.
#[derive(Clone)]
enum Read {
    Binding(Arc<binding::Reference>),
    Token(Arc<token::Reference>),
}

impl Read {
    fn data(&self) -> Data {
        match self {
            Self::Binding(reference) => Data::Binding(Arc::clone(reference)),
            Self::Token(reference) => Data::Token(Arc::clone(reference)),
        }
    }

    fn part(&self) -> Part {
        match self {
            Self::Binding(reference) => Part::Binding(Arc::clone(reference)),
            Self::Token(reference) => Part::Reference(Arc::clone(reference)),
        }
    }
}

/// Module data shared by every call conversion.
struct Module<'m, 'a> {
    allocator: &'a Allocator,
    bodies: &'m FxHashMap<u32, &'a ObjectExpression<'a>>,
    calls: &'m [Call<'a>],
    contributions: &'m contributions::Contributions<'a>,
    native: bool,
    offsets: &'m Utf16Index,
    selectors: &'m selectors::Selectors<'m, 'a>,
    statics: &'m Static<'a>,
    strings: &'m Strings<'a>,
    styles: &'m [Arc<NamedStyle>],
    variables: &'m Variables<'a>,
}

/// Authored keys and values of one extraction, so each repeated spelling shares one allocation.
#[derive(Default)]
struct Strings<'a> {
    table: RefCell<FxHashMap<&'a str, Arc<str>>>,
}

impl<'a> Strings<'a> {
    fn get(&self, text: &'a str) -> Arc<str> {
        let mut table = self.table.borrow_mut();

        if let Some(shared) = table.get(text) {
            return Arc::clone(shared);
        }

        let shared: Arc<str> = Arc::from(text);

        table.insert(text, Arc::clone(&shared));
        shared
    }
}

/// An authored property path. Most paths hold a definition name and one key.
type Path = SmallVec<[Arc<str>; 4]>;

/// Converts one call's literal body into style data, reporting unsupported syntax.
struct Converter<'c, 'm, 'p, 'a> {
    component: bool,
    call: &'a CallExpression<'a>,
    condition_keys: FxHashMap<String, Span>,
    dynamic: Option<Bindings<'c, 'a>>,
    /// Authored spans and paths of values and conditions, which diagnostics alone read.
    locations: Vec<(Span, Path)>,
    module: &'c Module<'m, 'a>,
    name: Arc<str>,
    reporter: &'c mut Reporter<'p>,
    theme: Option<Arc<Definition>>,
    themes: Option<&'c mut Themes<'a>>,
    typography: FxHashMap<u32, u32>,
    typography_queries: FxHashMap<u32, u32>,
}

/// A key: an identifier name or literal spelling.
fn property_key<'a>(key: &PropertyKey<'a>) -> Option<Cow<'a, str>> {
    match key {
        PropertyKey::StaticIdentifier(identifier) => Some(Cow::Borrowed(identifier.name.as_str())),
        PropertyKey::Identifier(identifier) => Some(Cow::Borrowed(identifier.name.as_str())),
        key => statics::key_literal(key),
    }
}

impl<'a> Converter<'_, '_, '_, 'a> {
    fn report(&mut self, message: impl Into<String>, span: Span) {
        self.reporter
            .report(Code::UnsupportedSyntax, message, Some(span));
    }

    fn path(&self, prefix: &[Arc<str>], key: &Arc<str>) -> Path {
        let mut path = Path::with_capacity(prefix.len() + 2);

        path.push(Arc::clone(&self.name));
        path.extend(prefix.iter().cloned());
        path.push(Arc::clone(key));
        path
    }

    /// The recorded locations with UTF-16 offsets, as diagnostics report them.
    fn locations(&self) -> Vec<SourceLocation> {
        self.locations
            .iter()
            .map(|(span, path)| SourceLocation {
                end: self.module.offsets.utf16(span.end),
                path: path.to_vec(),
                source: Arc::clone(&self.reporter.module_id),
                start: self.module.offsets.utf16(span.start),
            })
            .collect()
    }

    fn token(&self, start: u32) -> Option<(u32, Read)> {
        if let Some(read) = self.module.variables.references.get(&start) {
            return Some((read.end, Read::Binding(Arc::clone(&read.reference))));
        }

        self.themes
            .as_deref()
            .and_then(|themes| themes.tokens.get(&start))
            .map(|token| (token.end, Read::Token(Arc::clone(&token.reference))))
    }

    fn resolve_dynamic(&mut self, node: &Expression<'a>) -> Option<Arc<binding::Reference>> {
        let dynamic = self.dynamic?;

        match dynamic.resolve(node) {
            Ok(slot) => slot,
            Err(Error::Themes { message, span }) => {
                self.report(message, span);
                None
            }
            Err(_) => None,
        }
    }

    fn local_slot(
        &mut self,
        node: &Expression<'a>,
        prefix: &[Arc<str>],
    ) -> Option<Arc<binding::Reference>> {
        let slot = self.resolve_dynamic(node)?;

        if prefix.iter().any(|key| {
            !condition::local(key) && !self.module.selectors.local_conditions.contains(key)
        }) {
            self.report(
                "Dynamic values require conditions that select the styled element.",
                node.span(),
            );

            return None;
        }

        Some(slot)
    }

    fn shorthands(&self) -> Option<&token::Map<Arc<[Arc<str>]>>> {
        self.theme
            .as_ref()
            .and_then(|theme| theme.metadata.contract.shorthands.as_ref())
    }

    /// Defines a flat object of literal strings and numbers without a theme, as [`Self::object`]
    /// and [`Self::define`] would. Anything else, and any declaration that reports a diagnostic,
    /// returns `None` for the general conversion.
    fn literal(
        &self,
        argument: &'a ObjectExpression<'a>,
        name: &Arc<str>,
    ) -> Option<style::Definition> {
        if self.theme.is_some() || self.themes.is_some() || self.dynamic.is_some() {
            return None;
        }

        let module = self.module;
        let mut declarer = style::Declarer::new();
        let mut keys: SmallVec<[&str; 16]> = SmallVec::new();
        let mut declarations: Vec<style::Declaration> =
            Vec::with_capacity(argument.properties.len());

        for entry in &argument.properties {
            let ObjectPropertyKind::ObjectProperty(property) = entry else {
                return None;
            };

            if property.kind != PropertyKind::Init
                || property.method
                || property.computed
                || property.shorthand
            {
                return None;
            }

            let start = property.key.span().start;

            if module.selectors.conditions.contains_key(&start)
                || module.variables.references.contains_key(&start)
                || module.contributions.query_keys.contains_key(&start)
            {
                return None;
            }

            let (
                PropertyKey::StaticIdentifier(_) | PropertyKey::StringLiteral(_),
                Some(Cow::Borrowed(key)),
            ) = (&property.key, property_key(&property.key))
            else {
                return None;
            };

            if matches!(key, "selectors" | "targets" | "typography" | "vars")
                || condition::is(key)
                || keys.contains(&key)
            {
                return None;
            }

            keys.push(key);

            let value = unwrap(&property.value);
            let span = value.span();

            if module.variables.references.contains_key(&span.start)
                || module.contributions.references.contains_key(&span.start)
            {
                return None;
            }

            let input = match value {
                Expression::StringLiteral(literal) => {
                    Data::String(module.strings.get(literal.value.as_str()))
                }
                Expression::NumericLiteral(literal) => Data::Number(literal.value),
                Expression::UnaryExpression(unary)
                    if matches!(
                        unary.operator,
                        UnaryOperator::UnaryNegation | UnaryOperator::UnaryPlus
                    ) =>
                {
                    let Expression::NumericLiteral(literal) = &unary.argument else {
                        return None;
                    };

                    Data::Number(if unary.operator == UnaryOperator::UnaryNegation {
                        -literal.value
                    } else {
                        literal.value
                    })
                }
                _ => return None,
            };

            if !declarer.declare(name, &module.strings.get(key), &input, &mut declarations) {
                return None;
            }
        }

        Some(style::Definition {
            labels: None,
            styles: vec![Arc::new(NamedStyle {
                declarations,
                name: Arc::clone(name),
                ..NamedStyle::default()
            })],
        })
    }

    /// Converts a literal style object.
    fn object(&mut self, argument: &'a ObjectExpression<'a>, prefix: &[Arc<str>]) -> Data {
        let mut values = Object::new();
        let target = prefix.iter().rposition(|key| &**key == "targets");

        if target.is_some() && prefix.len() > 64 {
            self.report("Target nesting exceeds 64 levels.", argument.span);
            return Data::from(values);
        }

        let depth = prefix.len() + 2;
        let mut properties: Vec<&'a ObjectPropertyKind<'a>> = Vec::new();

        for entry in &argument.properties {
            let key = match entry {
                ObjectPropertyKind::ObjectProperty(property) if !property.computed => {
                    match &property.key {
                        PropertyKey::StaticIdentifier(identifier) => Some(identifier.name.as_str()),
                        PropertyKey::StringLiteral(literal) => Some(literal.value.as_str()),
                        _ => None,
                    }
                }
                _ => None,
            };
            let Some(key @ ("selectors" | "vars")) = key else {
                properties.push(entry);
                continue;
            };
            let object = match entry {
                ObjectPropertyKind::ObjectProperty(property)
                    if property.kind == PropertyKind::Init
                        && !property.method
                        && !property.shorthand =>
                {
                    match &property.value {
                        Expression::ObjectExpression(object) => Some(object),
                        _ => None,
                    }
                }
                _ => None,
            };
            let Some(object) = object else {
                self.report(
                    format!("{key} requires an explicit literal object."),
                    entry.span(),
                );
                continue;
            };

            for property in &object.properties {
                let valid = match property {
                    ObjectPropertyKind::ObjectProperty(property) => {
                        let start = property.key.span().start;

                        if key == "selectors" {
                            self.module.selectors.conditions.contains_key(&start)
                        } else {
                            property.computed
                                && self.module.variables.references.contains_key(&start)
                        }
                    }
                    ObjectPropertyKind::SpreadProperty(_) => false,
                };

                if !valid {
                    self.report(
                        if key == "selectors" {
                            "Selectors require explicit & targets."
                        } else {
                            "Variable assignments require declared variable keys."
                        },
                        property.span(),
                    );
                    continue;
                }

                properties.push(property);
            }
        }

        for entry in &properties {
            let ObjectPropertyKind::ObjectProperty(property) = entry else {
                self.report(
                    "Only explicit literal properties are supported; spreads, computed keys, shorthand, and methods are not evaluated.",
                    entry.span(),
                );
                continue;
            };
            let start = property.key.span().start;
            let condition = self.module.selectors.conditions.get(&start);
            let variable = self.module.variables.references.get(&start);
            let query = self.module.contributions.query_keys.get(&start);
            let identifier = matches!(
                property.key,
                PropertyKey::StaticIdentifier(_) | PropertyKey::Identifier(_)
            );
            let string = matches!(property.key, PropertyKey::StringLiteral(_));

            if property.kind != PropertyKind::Init
                || property.method
                || (property.computed
                    && condition.is_none()
                    && variable.is_none()
                    && query.is_none())
                || property.shorthand
                || (condition.is_none() && variable.is_none() && !identifier && !string)
            {
                // Template keys with an & target are selectors outside their group.
                let selector = property.computed
                    && property.key.as_expression().is_some_and(|key| {
                        matches!(unwrap(key), Expression::TemplateLiteral(template)
                            if template.quasis.iter().any(|quasi| quasi.value.raw.contains('&')))
                    });

                self.report(
                    if selector {
                        "Template selector keys require a selectors object."
                    } else {
                        "Only explicit literal properties are supported; spreads, computed keys, shorthand, and methods are not evaluated."
                    },
                    property.span,
                );
                continue;
            }

            let mut key: Arc<str> = match (variable, condition, query) {
                (Some(variable), _, _) => Arc::from(variable.reference.name.as_str()),
                (None, Some(condition), _) => Arc::clone(condition),
                (None, None, Some(query)) => Arc::clone(query),
                (None, None, None) => match property_key(&property.key) {
                    Some(Cow::Borrowed(key)) => self.module.strings.get(key),
                    key => Arc::from(key.unwrap_or_default()),
                },
            };

            if self.component && condition::is(&key) && values.has(&key) {
                // Comments distinguish ordered condition entries without changing specificity.
                let selector = Arc::clone(&key);
                let mut occurrence = 1;

                while values.has(&key) {
                    key = Arc::from(format!("{selector}/*base-ui-{occurrence}*/"));
                    occurrence += 1;
                }
            }

            if values.has(&key) {
                self.report(
                    "Duplicate properties are not supported in source definitions yet.",
                    property.span,
                );
                continue;
            }

            if (&*key == "targets" || target.is_some())
                && self.module.statics.absent(&property.value)
            {
                continue;
            }

            if &*key == "targets" || prefix.last().is_some_and(|last| &**last == "targets") {
                let input = unwrap(&property.value);
                let Expression::ObjectExpression(input) = input else {
                    self.report(
                        "Target branches require static declaration objects.",
                        input.span(),
                    );
                    continue;
                };
                let nested = [prefix, &[Arc::clone(&key)]].concat();
                let value = self.object(input, &nested);

                values.insert_new(key, value);
                continue;
            }

            if let Some(target) = target
                && prefix
                    .get(target + 1)
                    .is_none_or(|branch| &**branch != "web")
            {
                let nested = [prefix, &[Arc::clone(&key)]].concat();
                let value = self.native(&property.value, &nested, 0);

                values.insert_new(key, value);
                continue;
            }

            if condition::is(&key) {
                let path = self.path(prefix, &key);
                let encoded = js::stringify(&js::Value::Array(
                    path.iter().map(|part| js::Value::from(&**part)).collect(),
                ));

                self.condition_keys.insert(encoded, property.key.span());

                let input = unwrap(&property.value);
                let Expression::ObjectExpression(input) = input else {
                    self.report(
                        "Conditions require literal declaration objects.",
                        input.span(),
                    );
                    continue;
                };
                self.locations.push((property.span, path));

                let nested = [prefix, &[Arc::clone(&key)]].concat();
                let value = self.object(input, &nested);

                values.insert_new(key, value);
                continue;
            }

            let targets = self
                .shorthands()
                .and_then(|shorthands| shorthands.get(&key))
                .map(Arc::clone);
            let path = self.path(prefix, &key);
            let value = self.value(
                &property.value,
                path,
                prefix,
                depth,
                targets.as_deref().unwrap_or(std::slice::from_ref(&key)),
            );

            values.insert_new(key, value);
        }

        if let Some(Data::String(typography)) = values.get("typography") {
            let theme = self.theme.clone();
            let mappings = self.shorthands();
            let mut explicit: Vec<Arc<str>> = Vec::new();

            for key in values.keys() {
                match mappings.and_then(|mappings| mappings.get(key)) {
                    Some(targets) => explicit.extend(targets.iter().cloned()),
                    None => explicit.push(Arc::clone(key)),
                }
            }

            let explicit: Vec<&str> = explicit.iter().map(|key| &**key).collect();
            let authored = Data::String(Arc::clone(typography));
            let name = match value::parse(&authored, "fontFamily") {
                Some(value::Parsed::Marked { value, .. }) => value,
                _ => authored,
            };
            let keys = typography::keys(theme.as_deref(), &name, &explicit);
            let queries = keys.iter().filter(|key| typography::condition(key)).count();

            for entry in &properties {
                let ObjectPropertyKind::ObjectProperty(property) = entry else {
                    continue;
                };
                let key = match &property.key {
                    PropertyKey::StaticIdentifier(identifier) => Some(identifier.name.as_str()),
                    PropertyKey::Identifier(identifier) => Some(identifier.name.as_str()),
                    PropertyKey::StringLiteral(literal) => Some(literal.value.as_str()),
                    _ => None,
                };

                if key == Some("typography") {
                    self.typography.insert(
                        property.span.start,
                        u32::try_from(keys.len() - queries).unwrap_or(u32::MAX),
                    );

                    if queries > 0 {
                        self.typography_queries.insert(
                            property.span.start,
                            u32::try_from(queries).unwrap_or(u32::MAX),
                        );
                    }
                }
            }
        }

        Data::from(values)
    }

    /// Converts a native target branch value.
    fn native(&mut self, input: &'a Expression<'a>, prefix: &[Arc<str>], depth: usize) -> Data {
        let node = unwrap(input);

        if depth > 64 {
            self.report("Native value nesting exceeds 64 levels.", node.span());
            return Data::Undefined;
        }

        match node {
            Expression::ObjectExpression(object) => return self.object(object, prefix),
            Expression::ArrayExpression(array) => {
                let mut values = Vec::with_capacity(array.elements.len());

                for element in &array.elements {
                    if let Some(element) = element.as_expression() {
                        values.push(self.native(element, prefix, depth + 1));
                    } else {
                        self.report("Native arrays require dense static entries.", array.span);
                        values.push(Data::Undefined);
                    }
                }

                return Data::Array(Arc::new(values));
            }
            Expression::NullLiteral(_) => return Data::Null,
            Expression::BooleanLiteral(literal) => return Data::Bool(literal.value),
            Expression::NumericLiteral(literal) => return Data::Number(literal.value),
            Expression::StringLiteral(literal) => return Data::string(literal.value.as_str()),
            Expression::UnaryExpression(unary)
                if matches!(
                    unary.operator,
                    UnaryOperator::UnaryNegation | UnaryOperator::UnaryPlus
                ) =>
            {
                if let Expression::NumericLiteral(literal) = &unary.argument {
                    let sign = if unary.operator == UnaryOperator::UnaryNegation {
                        -1.0
                    } else {
                        1.0
                    };

                    return Data::Number(sign * literal.value);
                }
            }
            Expression::TemplateLiteral(template) => {
                if let Some(Template::Text(text)) =
                    expression::template(template, 0, &mut |_, _| None, "")
                {
                    return Data::from(text);
                }
            }
            _ => {}
        }

        self.report(
            "Native branches require static literal values.",
            node.span(),
        );

        Data::Undefined
    }

    /// Converts a declaration value, validating its domain against every target property.
    fn value(
        &mut self,
        node: &'a Expression<'a>,
        path: Path,
        prefix: &[Arc<str>],
        depth: usize,
        targets: &[Arc<str>],
    ) -> Data {
        let unwrapped = unwrap(node);
        let span = unwrapped.span();
        let token = self.token(span.start);
        let reference = match self.local_slot(node, prefix) {
            Some(slot) => Some(Read::Binding(slot)),
            None => token
                .filter(|(end, _)| *end == span.end)
                .map(|(_, read)| read),
        };

        if let (Some(dynamic), Some(Read::Binding(slot))) = (self.dynamic, &reference)
            && dynamic.contains(slot)
            && path.len() > depth
        {
            self.report("Dynamic fallback entries are not supported.", node.span());
            return Data::Undefined;
        }

        let node = unwrapped;

        if let Some(animation) = self.module.contributions.references.get(&span.start) {
            if let Some(kind) = self.module.contributions.kinds.get(animation)
                && targets
                    .iter()
                    .any(|target| !rule_reference::accepts(*kind, target))
            {
                self.report(
                    "Named stylesheet reference is incompatible with this property.",
                    span,
                );
                return Data::Undefined;
            }

            return Data::String(Arc::clone(animation));
        }

        let template = match node {
            Expression::TemplateLiteral(template) => {
                self.template(template, &path, prefix, depth, targets)
            }
            _ => None,
        };

        if let Some(Template::Expression(expression)) = &template {
            for part in &expression.parts {
                let (accepted, message) = match part {
                    Part::Text(_) => continue,
                    Part::Binding(binding) => (
                        self.dynamic
                            .is_some_and(|dynamic| dynamic.contains(binding))
                            || targets.iter().all(|target| {
                                binding::accepts(binding.domain, target)
                                    || (binding.domain == Domain::Color
                                        && expression::accepts_color(
                                            expression,
                                            target,
                                            &expression::matcher(),
                                        ))
                            }),
                        "Variable domain is incompatible with this property.",
                    ),
                    Part::Reference(reference) => (
                        targets.iter().all(|target| {
                            token::accepts_reference(reference, target)
                                || (reference.contract.variable_set
                                    && expression::accepts_variables(
                                        expression,
                                        target,
                                        &expression::matcher(),
                                    ))
                                || (reference.group == "color"
                                    && expression::accepts_color(
                                        expression,
                                        target,
                                        &expression::matcher(),
                                    ))
                        }),
                        "Theme variable domain is incompatible with this property.",
                    ),
                };

                if !accepted {
                    self.report(message, span);
                    return Data::Undefined;
                }
            }
        }

        if let Some(Read::Token(reference)) = &reference
            && !targets
                .iter()
                .all(|target| token::accepts_reference(reference, target))
        {
            self.report(
                "Theme variable domain is incompatible with this property.",
                span,
            );
            return Data::Undefined;
        }

        if let Some(Read::Binding(reference)) = &reference {
            let slot = self
                .dynamic
                .is_some_and(|dynamic| dynamic.contains(reference))
                && reference.domain != Domain::Number;
            let accepted = targets.iter().all(|target| {
                binding::accepts(reference.domain, target)
                    || self
                        .dynamic
                        .is_some_and(|dynamic| dynamic.accepts(reference, target))
            });

            if !slot && !accepted {
                self.report("Variable domain is incompatible with this property.", span);
                return Data::Undefined;
            }
        }

        let result = if let Some(reference) = &reference {
            reference.data()
        } else if let Some(template) = template {
            match template {
                Template::Text(text) => Data::from(text),
                Template::Expression(expression) => Data::Expression(expression),
            }
        } else {
            match node {
                Expression::StringLiteral(literal) => {
                    Data::String(self.module.strings.get(literal.value.as_str()))
                }
                Expression::NumericLiteral(literal) => Data::Number(literal.value),
                Expression::UnaryExpression(unary)
                    if matches!(
                        unary.operator,
                        UnaryOperator::UnaryNegation | UnaryOperator::UnaryPlus
                    ) && matches!(unary.argument, Expression::NumericLiteral(_)) =>
                {
                    let Expression::NumericLiteral(literal) = &unary.argument else {
                        return Data::Undefined;
                    };

                    Data::Number(if unary.operator == UnaryOperator::UnaryNegation {
                        -literal.value
                    } else {
                        literal.value
                    })
                }
                Expression::ArrayExpression(array) if path.len() == depth => {
                    let mut values = Vec::with_capacity(array.elements.len());

                    for (index, element) in array.elements.iter().enumerate() {
                        let Some(element) = element.as_expression() else {
                            let span = match element {
                                ArrayExpressionElement::Elision(_) => array.span,
                                element => element.span(),
                            };

                            self.report(
                                "Fallback arrays require dense literal entries without spreads.",
                                span,
                            );
                            values.push(Data::Undefined);
                            continue;
                        };
                        let mut nested = path.clone();

                        nested.push(Arc::from(index.to_string()));
                        values.push(self.value(element, nested, prefix, depth, targets));
                    }

                    Data::Array(Arc::new(values))
                }
                _ => {
                    self.report(
                        "Expected a literal string or number; expressions are not evaluated.",
                        span,
                    );
                    return Data::Undefined;
                }
            }
        };
        self.locations.push((span, path));

        result
    }

    fn template(
        &mut self,
        node: &'a TemplateLiteral<'a>,
        path: &[Arc<str>],
        prefix: &[Arc<str>],
        depth: usize,
        targets: &[Arc<str>],
    ) -> Option<Template> {
        expression::template(
            node,
            0,
            &mut |expression, before| {
                let unwrapped = unwrap(expression);
                let contributions = self.module.contributions;

                if let Some(animation) = contributions.references.get(&unwrapped.span().start) {
                    if let Some(kind) = contributions.kinds.get(animation)
                        && targets.iter().any(|target| {
                            !rule_reference::accepts_expression(*kind, target, before)
                        })
                    {
                        self.report(
                            "Named stylesheet reference is incompatible with this property.",
                            expression.span(),
                        );
                        return None;
                    }

                    return Some(Part::Text(Arc::clone(animation)));
                }

                let span = expression.span();
                let token = self.token(span.start);

                if let Some(slot) = self.local_slot(expression, prefix) {
                    if path.len() > depth {
                        self.report("Dynamic fallback entries are not supported.", span);
                        return None;
                    }

                    return Some(Part::Binding(slot));
                }

                token
                    .filter(|(end, _)| *end == span.end)
                    .map(|(_, read)| read.part())
            },
            "",
        )
    }
}

/// Accepts an entry context that the composing call selects identically.
fn same_context(entry: Option<&NativeContext>, composite: Option<&NativeContext>) -> bool {
    let Some(entry) = entry else {
        return true;
    };
    let Some(composite) = composite else {
        return false;
    };

    if entry.default_vars != composite.default_vars || entry.vars.len() != composite.vars.len() {
        return false;
    }

    entry.vars.iter().all(|(name, left)| {
        composite.vars.get(name).is_some_and(|right| {
            let left = &left.metadata.contract;
            let right = &right.metadata.contract;

            Arc::ptr_eq(left, right) || (left.identity.is_some() && left.identity == right.identity)
        })
    })
}

/// Lists declarations in emitted order, through conditions and segments.
fn declarations(style: &NamedStyle) -> Vec<&style::Declaration> {
    match &style.rules {
        Some(rules) => rules
            .iter()
            .flat_map(|rule| declarations(&rule.style))
            .collect(),
        None => style.declarations.iter().collect(),
    }
}

/// A composed definition and its synthesized declaration body.
struct Composite<'a> {
    body: &'a ObjectExpression<'a>,
    definition: style::Definition,
}

impl<'a> Converter<'_, '_, '_, 'a> {
    fn define(&self, values: Data, name: &Arc<str>) -> Result<style::Definition> {
        let mut styles = Object::new();

        styles.insert(Arc::clone(name), values);

        let styles = Data::from(styles);
        let vars = self.theme.as_deref().map(style::Vars::Theme);

        // Locations only annotate diagnostics, so a valid definition never resolves them.
        style::define(
            &styles,
            &style::Options {
                locations: &[],
                vars,
            },
        )
        .or_else(|_| {
            style::define(
                &styles,
                &style::Options {
                    locations: &self.locations(),
                    vars,
                },
            )
        })
    }

    /// Composes ordered entries; later entries win as authored declarations do.
    fn compose(
        &mut self,
        elements: &'a ArenaVec<'a, ArrayExpressionElement<'a>>,
        before: usize,
    ) -> Result<Composite<'a>> {
        let builder = AstBuilder::new(self.module.allocator);
        let mut parts: Vec<Arc<NamedStyle>> = Vec::new();
        let mut properties = ArenaVec::new_in(&self.module.allocator);

        for element in elements {
            let entry = element.as_expression().map(unwrap);

            if let Some(Expression::ObjectExpression(object)) = entry {
                let values = self.object(object, &[]);

                if self.reporter.len() != before {
                    continue;
                }

                let name = Arc::clone(&self.name);
                let definition = self.define(values, &name)?;

                parts.extend(definition.styles.into_iter().take(1));

                for property in &object.properties {
                    properties.push(property.clone_in_with_semantic_ids(self.module.allocator));
                }

                continue;
            }

            let target = entry.and_then(|entry| {
                self.module
                    .selectors
                    .compositions
                    .get(&entry.span().start)
                    .copied()
            });
            let local = match target {
                Some(selectors::Target::Call(call)) => self
                    .module
                    .calls
                    .iter()
                    .find(|value| value.start == call.span.start),
                _ => None,
            };
            let packed = match target {
                Some(selectors::Target::Link(link)) => link.style.as_deref(),
                _ => None,
            };
            let style = match (local, packed) {
                (Some(local), _) => self
                    .module
                    .styles
                    .iter()
                    .find(|style| style.name == local.name)
                    .cloned(),
                (None, Some(packed)) => Some(Arc::clone(&packed.style)),
                (None, None) => None,
            };
            let span = match element {
                ArrayExpressionElement::Elision(_) => self.call.span,
                element => element.span(),
            };
            let Some(style) = style else {
                self.report(
                    "Composition entries require literal objects or previously declared style definitions.",
                    span,
                );
                continue;
            };
            let entry_span = entry.map_or(span, GetSpan::span);
            let variant =
                local.is_some_and(|local| local.recipe.is_some() || local.slots.is_some())
                    || packed.is_some_and(|packed| {
                        packed.dynamic.is_some()
                            || packed.static_recipe.as_ref().is_some_and(|recipe| {
                                !(recipe.rules.len() == 1
                                    && recipe.rules.first().is_some_and(|rule| {
                                        rule.value.styles.len() == 1
                                            && rule.value.styles.first().is_some_and(|value| {
                                                value.name == packed.style.name
                                            })
                                    }))
                            })
                    });

            if variant {
                self.report(
                    "Composition entries cannot be variants or dynamic styles; apply them with cx.",
                    entry_span,
                );
                continue;
            }

            // Native tables select variable alternatives from one context per call.
            if self.module.native {
                let call = self.call.span;
                let (entry_context, composite) = match self.themes.as_deref_mut() {
                    Some(themes) => {
                        let entry_context = match local {
                            Some(local) => themes.native_context(local.start, local.end)?,
                            None => packed.and_then(|packed| packed.native_context.clone()),
                        };

                        (entry_context, themes.native_context(call.start, call.end)?)
                    }
                    None => (
                        packed
                            .filter(|_| local.is_none())
                            .and_then(|packed| packed.native_context.clone()),
                        None,
                    ),
                };

                if !same_context(entry_context.as_ref(), composite.as_ref()) {
                    self.report(
                        "Native composition entries require the variable catalog of the composing style.",
                        entry_span,
                    );
                    continue;
                }
            }

            // The composing configuration decides output for every copied entry.
            parts.push(Arc::new(NamedStyle {
                composition: None,
                css_output: None,
                ..(*style).clone()
            }));

            if let Some(local) = local {
                if let Some(body) = self.module.bodies.get(&local.start) {
                    for property in &body.properties {
                        properties.push(property.clone_in_with_semantic_ids(self.module.allocator));
                    }
                }

                for (start, count) in local.typography.iter().flatten() {
                    self.typography.insert(*start, *count);
                }

                for (start, count) in local.typography_queries.iter().flatten() {
                    self.typography_queries.insert(*start, *count);
                }

                continue;
            }

            // Packed declarations have no authored source here, so they map to the entry.
            for declaration in declarations(&style) {
                let allocator = self.module.allocator;
                let raw: &'a str = allocator.alloc_str(&js::quote(&declaration.property));
                let key = PropertyKey::new_string_literal(
                    entry_span,
                    allocator.alloc_str(&declaration.property),
                    Some(raw.into()),
                    &builder,
                );
                let value =
                    Expression::new_string_literal(entry_span, "", Some("\"\"".into()), &builder);

                properties.push(ObjectPropertyKind::new_object_property(
                    entry_span,
                    PropertyKind::Init,
                    key,
                    value,
                    false,
                    false,
                    false,
                    &builder,
                ));
            }
        }

        let body: &'a ObjectExpression<'a> = self.module.allocator.alloc(ObjectExpression::new(
            self.call.span,
            properties,
            &builder,
        ));

        Ok(Composite {
            body,
            definition: style::Definition {
                labels: None,
                styles: vec![Arc::new(NamedStyle {
                    declarations: Vec::new(),
                    name: Arc::clone(&self.name),
                    rules: Some(
                        parts
                            .into_iter()
                            .map(|style| style::Rule {
                                condition: None,
                                style,
                            })
                            .collect(),
                    ),
                    ..NamedStyle::default()
                })],
            },
        })
    }

    /// Checks variable values and conditions of a validated style.
    fn validate(&mut self, style: &NamedStyle, path: &[Arc<str>]) {
        for declaration in &style.declarations {
            if let style::Value::Token(reference) = &declaration.value
                && reference.contract.variable_set
                && literal::rule(&declaration.property)
                    .is_some_and(|rule| rule.kind == LiteralKind::Identifier)
                && !expression::accepts_identifier(
                    reference,
                    &declaration.property,
                    &expression::matcher(),
                )
            {
                self.reporter.report(
                    Code::InvalidLiteral,
                    "Variable value is incompatible with this property.",
                    Some(self.call.span),
                );
            }
        }

        if let Some(web) = style
            .targets
            .as_ref()
            .and_then(|targets| targets.web.as_ref())
        {
            let mut nested = path.to_vec();

            nested.push(Arc::from("targets"));
            nested.push(Arc::from("web"));
            self.validate(web, &nested);
        }

        for rule in style.rules.iter().flatten() {
            let mut nested = path.to_vec();

            if let Some(condition) = &rule.condition {
                nested.push(Arc::clone(condition));

                let encoded = js::stringify(&js::Value::Array(
                    nested.iter().map(|part| js::Value::from(&**part)).collect(),
                ));
                let location = self
                    .condition_keys
                    .get(&encoded)
                    .copied()
                    .unwrap_or(self.call.span);

                if let Err(error) = at_rules::validate(
                    &format!(".z{{{condition}{{color:red;}}}}"),
                    &self.reporter.module_id,
                ) {
                    self.report(
                        format!("Invalid selector or condition: {}", error.text()),
                        location,
                    );
                }
            }

            self.validate(&rule.style, &nested);
        }
    }
}

/// The module namespace: paired 32-bit FNV hashes of the UTF-16 module identity in base 36.
fn namespace(value: &str) -> String {
    let mut first: u32 = 2_166_136_261;
    let mut second: u32 = 2_246_822_507;

    for code in js::code_units(value) {
        first = (first ^ u32::from(code)).wrapping_mul(16_777_619);
        second = (second ^ u32::from(code)).wrapping_mul(3_266_489_909);
    }

    format!(
        "{}{}",
        js::radix(u64::from(first), 36),
        js::radix(u64::from(second), 36)
    )
}

/// Whether a module identity is portable: package-relative, without absolute paths,
/// backslashes, or traversal segments.
fn portable(module_id: &str) -> bool {
    !module_id.is_empty()
        && !module_id.contains('\\')
        && !module_id.contains(':')
        && module_id
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

/// Strips `/\.[cm]?[jt]sx?$/` from a file name.
fn stem(name: &str) -> &str {
    for extension in [
        ".cjs", ".cjsx", ".cts", ".ctsx", ".js", ".jsx", ".mjs", ".mjsx", ".mts", ".mtsx", ".ts",
        ".tsx",
    ] {
        if let Some(stem) = name.strip_suffix(extension) {
            return stem;
        }
    }

    name
}

/// Whether a contribution asset URL is absolute, scheme-qualified, or a fragment or query.
fn absolute(url: &str) -> bool {
    let bytes = url.as_bytes();

    if matches!(bytes.first(), Some(b'/' | b'?' | b'#')) {
        return true;
    }

    let Some(first) = bytes.first() else {
        return false;
    };

    if !first.is_ascii_alphabetic() {
        return false;
    }

    for byte in bytes.get(1..).unwrap_or_default() {
        if *byte == b':' {
            return true;
        }

        if !(byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'.' | b'-')) {
            return false;
        }
    }

    false
}

/// The packed style of an exported style reference, and of its members.
fn exported_style(
    link: &Link,
    calls: &[Call<'_>],
    styles: &[Arc<NamedStyle>],
    themes: &mut Option<Themes<'_>>,
) -> Result<Link> {
    let mut link = link.clone();
    let call = calls
        .iter()
        .find(|call| call.identity.as_deref() == Some(&*link.binding));
    let style = call.and_then(|call| styles.iter().find(|style| style.name == call.name));

    if let (Some(call), Some(style)) = (call, style) {
        let mut call = call.clone();

        call.native_context = match themes.as_mut() {
            Some(themes) => themes.native_context(call.start, call.end)?,
            None => None,
        };
        link.style = Some(Arc::new(packed_styles::create(&call, Arc::clone(style))));
    }

    if let Some(members) = &link.members {
        let mut packed = Record::new();

        for (name, member) in members.iter() {
            packed.insert(
                Arc::clone(name),
                exported_style(member, calls, styles, themes)?,
            );
        }

        link.members = Some(packed);
    }

    Ok(link)
}

/// Extracts direct style calls and local theme definitions imported from `zyzz`.
///
/// Parses TypeScript and JSX without reading files, loading configuration, or evaluating
/// source. The source text is unchanged.
///
/// # Errors
///
/// Returns [`Error::Extract`] for syntax errors, unsupported imported references, and invalid
/// literals, with every diagnostic. Other errors are the failures the TypeScript compiler
/// rethrows, such as invalid configuration options.
pub fn extract<'a>(allocator: &'a Allocator, options: &Options<'_, 'a>) -> Result<Extracted<'a>> {
    let module_id: Arc<str> = Arc::from(options.module_id);

    if !portable(options.module_id) {
        return Err(Error::Extract(ExtractError::new(vec![Diagnostic {
            code: Code::InvalidModule,
            end: 0,
            message: "Expected a portable package-relative module ID without absolute paths, backslashes, or traversal segments.".to_owned(),
            source: module_id,
            start: 0,
        }])));
    }

    let namespace = namespace(options.module_id);
    let owned;
    let parsed = if let Some(parsed) = options.parsed {
        parsed
    } else {
        owned = syntax::parse(allocator, options.source, options.module_id);
        &owned
    };
    let program = parsed.program;

    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };

        if import.source.value != "zyzz" {
            continue;
        }

        for specifier in import.specifiers.iter().flatten() {
            let ImportDeclarationSpecifier::ImportSpecifier(specifier) = specifier else {
                continue;
            };
            let name = specifier.imported.name();

            if name == "Theme" || name == "Variables" {
                return Err(Error::Extract(ExtractError::new(vec![Diagnostic {
                    code: Code::UnsupportedSyntax,
                    end: parsed.utf16(specifier.span.end),
                    message: format!("Import Vars instead of {name}."),
                    source: module_id,
                    start: parsed.utf16(specifier.span.start),
                }])));
            }
        }
    }

    let mut reporter = Reporter {
        diagnostics: Vec::new(),
        module_id: Arc::clone(&module_id),
        offsets: &parsed.offsets,
    };

    if !parsed.errors.is_empty() {
        for error in &parsed.errors {
            reporter.diagnostics.push(Diagnostic {
                code: Code::SyntaxError,
                end: error.end,
                message: error.message.clone(),
                source: Arc::clone(&module_id),
                start: error.start,
            });
        }

        return Err(reporter.fail());
    }

    let context = options.context;
    let empty = Record::new();
    let links = context.map_or(&empty, |context| &context.links);
    let constants: FxHashMap<String, &'a Expression<'a>> = context
        .and_then(|context| context.constants.as_ref())
        .map(|constants| {
            constants
                .iter()
                .map(|(name, value)| (name.to_string(), *value))
                .collect()
        })
        .unwrap_or_default();
    let statics = statics::collect(allocator, program, &parsed.semantic, constants);
    let mut contributions = match contributions::scan(
        parsed,
        &namespace,
        links,
        context.and_then(|context| context.factories.as_ref()),
    ) {
        Ok(contributions) => contributions,
        Err(error) => {
            reporter.unsupported(error)?;
            return Err(reporter.fail());
        }
    };
    let variables = match vars::collect(parsed, &namespace, links, options.module_id) {
        Ok(variables) => variables,
        Err(error) => {
            reporter.unsupported(error)?;
            return Err(reporter.fail());
        }
    };
    let file = options.module_id.rsplit('/').next().unwrap_or_default();
    let mut themes = match themes::collect(
        parsed,
        themes::Options {
            contribution_calls: contributions.calls.iter().map(|call| call.start).collect(),
            linked: context.is_some(),
            links: links.clone(),
            namespace: Arc::from(format!(
                "src-{}-{}",
                identity::label(stem(file)),
                identity::compact(options.module_id)
            )),
            native: options.target == Target::Native,
            static_bindings: statics.bindings().collect(),
        },
        &statics,
    ) {
        Ok(themes) => themes,
        Err(error) => {
            reporter.unsupported(error)?;
            return Err(reporter.fail());
        }
    };
    let mut walker = Walker {
        ancestors: Vec::new(),
        contributions: &mut contributions,
        fatal: None,
        parsed,
        pending: Vec::new(),
        recipes: FxHashSet::default(),
        reporter: &mut reporter,
        node: NodeId::DUMMY,
        themes: themes.as_mut(),
        variables: &variables,
    };

    walker.scan();

    let Walker {
        fatal,
        mut pending,
        mut recipes,
        ..
    } = walker;

    if let Some(error) = fatal {
        return Err(error);
    }

    contributions.resolve();

    // Imports and reference lists can have a different order from authored calls.
    if let Some(themes) = &themes {
        for entry in themes.styles.values() {
            pending.push(entry.call);

            if entry.recipe {
                recipes.insert(entry.call.span.start);
            }
        }
    }

    pending.sort_by_key(|call| call.span.start);

    let static_calls: FxHashSet<u32> = pending
        .iter()
        .map(|call| call.span.start)
        .chain(contributions.calls.iter().map(|call| call.start))
        .collect();
    let opaque: FxHashSet<u32> = variables.references.keys().copied().collect();
    let mut normalized: FxHashMap<u32, std::result::Result<&'a Expression<'a>, Error>> =
        FxHashMap::default();
    let mut selector_keys = FxHashSet::default();
    let mut composed: Vec<&'a Expression<'a>> = Vec::new();
    let mut component_calls = FxHashSet::default();
    let mut component_conditions = FxHashMap::default();

    for call in &pending {
        // A spread argument has no static value, and the call reports it below.
        let Some(mut argument) = call.arguments.first().and_then(Argument::as_expression) else {
            continue;
        };
        let opted_in = themes
            .as_ref()
            .and_then(|themes| themes.styles.get(&call.span.start))
            .is_some_and(|entry| entry.base_ui && !entry.recipe)
            || match unwrap(&call.callee) {
                Expression::Identifier(identifier) => scope::resolve(&parsed.semantic, identifier)
                    .is_some_and(|binding| binding.imported_from("zyzz/base-ui/react")),
                _ => false,
            };
        let first = statics.normalize(argument, &static_calls, &opaque, false);
        let component = if opted_in
            && call.arguments.len() >= 2
            && !matches!(
                &first,
                Ok(Expression::ObjectExpression(_)
                    | Expression::ArrayExpression(_)
                    | Expression::ArrowFunctionExpression(_))
            ) {
            component_calls.insert(call.span.start);

            if options.target == Target::Native {
                normalized.insert(
                    call.span.start,
                    Err(invalid(
                        "Base UI component styles require a web compilation target.",
                        call.span,
                    )),
                );
                continue;
            }

            match base_ui::component(&parsed.semantic, argument) {
                Ok(component) => {
                    let Some(body) = call.arguments.get(1).and_then(Argument::as_expression) else {
                        normalized.insert(
                            call.span.start,
                            Err(invalid(
                                "Base UI component styles require a static object.",
                                call.span,
                            )),
                        );
                        continue;
                    };

                    argument = body;
                    Some(component)
                }
                Err(error) => {
                    normalized.insert(call.span.start, Err(error));
                    continue;
                }
            }
        } else {
            None
        };
        let value = match if component.is_some() {
            statics.normalize(argument, &static_calls, &opaque, false)
        } else {
            first
        } {
            Ok(value) => value,
            Err(error @ Error::Themes { .. }) => {
                normalized.insert(call.span.start, Err(error));
                continue;
            }
            Err(error) => return Err(error),
        };
        let value = if let Some(component) = component {
            match base_ui::lower(allocator, value, component, &mut component_conditions, 0) {
                // Normalization already resolved authored data. Re-normalizing would
                // merge conditions expanded from distinct state and selector blocks.
                Ok(value) => allocator.alloc(value),
                Err(error) => {
                    normalized.insert(call.span.start, Err(error));
                    continue;
                }
            }
        } else {
            value
        };

        if let Expression::ArrayExpression(array) = value {
            for element in &array.elements {
                if let Some(entry) = element.as_expression().map(unwrap)
                    && matches!(
                        entry,
                        Expression::Identifier(_)
                            | Expression::StaticMemberExpression(_)
                            | Expression::ComputedMemberExpression(_)
                            | Expression::PrivateFieldExpression(_)
                    )
                {
                    composed.push(entry);
                }
            }
        }

        // Selector keys sit inside nested objects, which flat literal bodies lack.
        if flat(value) {
            normalized.insert(call.span.start, Ok(value));
            continue;
        }

        let mut keys = SelectorKeys {
            keys: &mut selector_keys,
        };

        match value {
            Expression::ArrowFunctionExpression(arrow) => match arrow.get_expression() {
                Some(body) => match statics.normalize(body, &static_calls, &opaque, false) {
                    Ok(body) => keys.visit_expression(body),
                    Err(error @ Error::Themes { .. }) => {
                        normalized.insert(call.span.start, Err(error));
                        continue;
                    }
                    Err(error) => return Err(error),
                },
                None => keys.visit_arrow_function_body(&arrow.body),
            },
            value => keys.visit_expression(value),
        }

        normalized.insert(call.span.start, Ok(value));
    }

    for call in &pending {
        if let Err(error) = identifiers::explicit(
            call,
            if component_calls.contains(&call.span.start) {
                2
            } else {
                1
            },
        ) {
            reporter.report(Code::UnsupportedSyntax, error.text(), Some(call.span));
        }
    }

    if reporter.len() > 0 {
        return Err(reporter.fail());
    }

    let css_namespaces: FxHashMap<u32, Arc<str>> = themes
        .iter()
        .flat_map(|themes| themes.styles.iter())
        .filter_map(|(start, entry)| {
            entry
                .theme
                .metadata
                .contract
                .identity
                .as_deref()
                .and_then(|identity| identity.strip_prefix("id-"))
                .map(|identity| (*start, Arc::from(identity)))
        })
        .collect();
    let mut selectors = match selectors::scan(
        parsed,
        selectors::Options {
            calls: &pending,
            composed: &composed,
            component_calls: &component_calls,
            css_namespaces: &css_namespaces,
            links,
            module_id: options.module_id,
            namespace: &namespace,
            selector_keys: &selector_keys,
        },
    ) {
        Ok(selectors) => selectors,
        Err(error) => {
            reporter.unsupported(error)?;
            return Err(reporter.fail());
        }
    };
    selectors
        .local_conditions
        .extend(component_conditions.values().cloned());
    selectors.conditions.extend(component_conditions);
    let builder = AstBuilder::new(allocator);
    let compact = identity::compact(options.module_id);
    let suffix = compact.get(compact.len().saturating_sub(6)..).unwrap_or("");
    // Calls are large, so the list never regrows for the common one call per definition.
    let mut calls: Vec<Call<'a>> = Vec::with_capacity(pending.len());
    let mut styles: Vec<Arc<NamedStyle>> = Vec::with_capacity(pending.len());
    let mut bodies: FxHashMap<u32, &'a ObjectExpression<'a>> = FxHashMap::default();
    let mut name_counts: FxHashMap<&str, usize> =
        FxHashMap::with_capacity_and_hasher(pending.len(), FxBuildHasher);
    let mut name_indices: FxHashMap<&str, usize> =
        FxHashMap::with_capacity_and_hasher(pending.len(), FxBuildHasher);
    // Only authoring calls read their declaration paths, so other calls never build one.
    let call_names: Vec<String> = pending
        .iter()
        .map(|call| {
            let mut name = String::with_capacity(32);

            names::write(&parsed.semantic, call, &mut name);
            name
        })
        .collect();

    for name in &call_names {
        *name_counts.entry(name).or_default() += 1;
    }

    let strings = Strings::default();
    // Names build here before each moves into one shared allocation.
    let mut scratch = String::with_capacity(64);

    for (index, call) in pending.iter().copied().enumerate() {
        let explicit = match identifiers::explicit(
            call,
            if component_calls.contains(&call.span.start) {
                2
            } else {
                1
            },
        ) {
            Ok(explicit) => explicit,
            Err(error) => {
                reporter.report(Code::UnsupportedSyntax, error.text(), Some(call.span));
                None
            }
        };
        let bound = themes
            .as_ref()
            .and_then(|themes| themes.styles.get(&call.span.start))
            .map(|entry| (Arc::clone(&entry.theme), entry.output));
        let theme = bound.as_ref().map(|(theme, _)| Arc::clone(theme));
        let css_namespace: Option<Arc<str>> = theme
            .as_ref()
            .and_then(|theme| theme.metadata.contract.identity.as_deref())
            .and_then(|identity| identity.strip_prefix("id-"))
            .map(Arc::from);
        let authored = call_names.get(index).map_or("style", String::as_str);
        let position = name_indices.entry(authored).or_default();
        let name_index = *position;

        *position += 1;

        let css_name: Arc<str> = match &explicit {
            Some(explicit) => Arc::from(identity::name(explicit)),
            None if authored == "style" => Arc::from(format!("{suffix}-style-{index}")),
            None if name_counts.get(authored).copied().unwrap_or_default() > 1 => {
                Arc::from(format!("{suffix}-{authored}-{name_index}"))
            }
            None => {
                scratch.clear();
                scratch.push_str(suffix);
                scratch.push('-');
                scratch.push_str(authored);
                Arc::from(scratch.as_str())
            }
        };
        let prefix = css_namespace.as_deref().unwrap_or_default();
        let definition_id = match &explicit {
            None => {
                let mut id = String::with_capacity(prefix.len() + css_name.len() + 1);

                if !prefix.is_empty() {
                    id.push_str(prefix);
                    id.push('-');
                }

                id.push_str(&css_name);
                id
            }
            Some(explicit) => {
                let required = identity::require_id(Some(explicit), "style")?;
                let id = required.get(3..).unwrap_or_default();

                if prefix.is_empty() {
                    format!("id-{id}")
                } else {
                    format!("id-{prefix}-{id}")
                }
            }
        };
        let mut argument: Option<&'a Expression<'a>> =
            call.arguments.first().and_then(Argument::as_expression);

        if call.arguments.is_empty() {
            let at = Span::new(call.span.end - 1, call.span.end - 1);

            argument = Some(allocator.alloc(Expression::new_object_expression(
                at,
                ArenaVec::new_in(&allocator),
                &builder,
            )));
        }

        loop {
            argument = match argument {
                Some(Expression::TSAsExpression(inner)) => Some(&inner.expression),
                Some(Expression::TSSatisfiesExpression(inner)) => Some(&inner.expression),
                _ => break,
            };
        }

        let original = argument;

        match normalized.remove(&call.span.start) {
            Some(Ok(value)) => argument = Some(value),
            Some(Err(error)) => {
                reporter.unsupported(error)?;
                continue;
            }
            None => {}
        }

        let count = reporter.len();
        let dynamic = match argument {
            Some(argument) => match dynamic::read(argument, &definition_id, &mut |node| {
                statics.type_of(node, &mut Vec::new())
            }) {
                Ok(read) => read,
                Err(error) => {
                    reporter.unsupported(error)?;
                    None
                }
            },
            None => None,
        };

        if reporter.len() != count {
            continue;
        }

        if let Some(read) = &dynamic {
            match statics.normalize(read.expression, &static_calls, &opaque, false) {
                Ok(value) => argument = Some(value),
                Err(error) => {
                    reporter.unsupported(error)?;
                    continue;
                }
            }
        }

        let entries = match argument {
            Some(Expression::ArrayExpression(array))
                if dynamic.is_none() && !recipes.contains(&call.span.start) =>
            {
                Some(&array.elements)
            }
            _ => None,
        };

        if call.arguments.len()
            > if component_calls.contains(&call.span.start) {
                3
            } else {
                2
            }
            || (!matches!(argument, Some(Expression::ObjectExpression(_))) && entries.is_none())
        {
            reporter.report(
                Code::UnsupportedSyntax,
                "Expected one literal object, typed callback, or array of style definitions and literal objects; spreads are not supported.",
                Some(call.span),
            );
            continue;
        }

        let before = reporter.len();
        let mut expanded = None;

        if recipes.contains(&call.span.start)
            && let Some(object @ Expression::ObjectExpression(_)) = argument
        {
            if dynamic.is_some() {
                reporter.report(
                    Code::UnsupportedSyntax,
                    "Recipes require static top-level objects.",
                    Some(original.map_or(call.span, GetSpan::span)),
                );
                continue;
            }

            match recipes::expand(
                object,
                recipes::Options {
                    identity: &definition_id,
                    payloads: recipe_payloads::Options {
                        allocator,
                        allowed: &static_calls,
                        opaque: &opaque,
                        statics: &statics,
                    },
                    queries: theme
                        .as_ref()
                        .and_then(|theme| theme.metadata.queries.as_deref()),
                    source: options.source,
                },
            ) {
                Ok(value) => expanded = Some(value),
                Err(error) => {
                    reporter.unsupported(error)?;
                    continue;
                }
            }
        }

        let body_argument: Option<&'a ObjectExpression<'a>> = match &expanded {
            Some(expanded) => Some(expanded.body),
            None => match argument {
                Some(Expression::ObjectExpression(object)) => Some(object),
                _ => None,
            },
        };
        let name: Arc<str> = {
            scratch.clear();
            scratch.push_str("style-");
            scratch.push_str(&namespace);
            scratch.push('-');
            js::write_index(&mut scratch, parsed.utf16(call.span.start));
            Arc::from(scratch.as_str())
        };
        let module = Module {
            allocator,
            bodies: &bodies,
            calls: &calls,
            contributions: &contributions,
            native: options.target == Target::Native,
            offsets: &parsed.offsets,
            selectors: &selectors,
            statics: &statics,
            strings: &strings,
            styles: &styles,
            variables: &variables,
        };
        let slots = match (&expanded, &dynamic) {
            (Some(expanded), _) => Some(Bindings::Payloads(&expanded.bindings)),
            (None, Some(read)) => Some(Bindings::Read(read)),
            (None, None) => None,
        };
        let mut converter = Converter {
            component: component_calls.contains(&call.span.start),
            call,
            condition_keys: FxHashMap::default(),
            dynamic: slots,
            locations: Vec::new(),
            module: &module,
            name: Arc::clone(&name),
            reporter: &mut reporter,
            theme: theme.clone(),
            themes: themes.as_mut(),
            typography: FxHashMap::default(),
            typography_queries: FxHashMap::default(),
        };
        let literal = match (entries, body_argument) {
            (None, Some(object)) => converter.literal(object, &name),
            _ => None,
        };
        let values = match (entries, body_argument, &literal) {
            (None, Some(object), None) => Some(converter.object(object, &[])),
            _ => None,
        };

        if converter.reporter.len() != before {
            continue;
        }

        let converted = (|| -> Result<Option<(style::Definition, &'a ObjectExpression<'a>)>> {
            let composite = match entries {
                Some(entries) => Some(converter.compose(entries, before)?),
                None => None,
            };

            if converter.reporter.len() != before {
                return Ok(None);
            }

            let (definition, body) = match (composite, literal, values, body_argument) {
                (Some(composite), _, _, _) => (composite.definition, composite.body),
                (None, Some(definition), _, Some(body)) => (definition, body),
                (None, None, Some(values), Some(body)) => (converter.define(values, &name)?, body),
                _ => return Ok(None),
            };

            for style in &definition.styles {
                converter.validate(style, std::slice::from_ref(&style.name));
            }

            Ok(Some((definition, body)))
        })();
        let (definition, body) = match converted {
            Ok(Some(converted)) => converted,
            Ok(None) => continue,
            Err(Error::Style(diagnostics)) => {
                invalid_literals(converter.reporter, diagnostics, call.span);
                continue;
            }
            Err(error) => return Err(error),
        };

        if converter.reporter.len() != before {
            continue;
        }

        let retained = expanded.as_ref().and_then(|expanded| {
            expanded
                .static_recipe
                .as_ref()
                .map(|recipe| (true, recipe))
                .or_else(|| {
                    expanded
                        .dynamic_recipe
                        .as_ref()
                        .map(|recipe| (false, recipe))
                })
        });
        let mut target_recipe = None;
        let mut failed = false;

        if let Some((kind, recipe)) = retained {
            let mut rules = Vec::with_capacity(recipe.rules.len());

            for (position, rule) in recipe.rules.iter().enumerate() {
                let values = converter.object(rule.value, &[]);
                let rule_name: Arc<str> = Arc::from(format!("{name}-{position}"));

                match converter.define(values, &rule_name) {
                    Ok(value) => rules.push(recipe::Rule {
                        matches: rule.matches.clone(),
                        value,
                    }),
                    Err(Error::Style(diagnostics)) => {
                        invalid_literals(converter.reporter, diagnostics, call.span);
                        failed = true;
                        break;
                    }
                    Err(error) => return Err(error),
                }
            }

            target_recipe = Some((
                kind,
                recipe::Definition {
                    axes: recipe.axes.clone(),
                    defaults: recipe.defaults.clone(),
                    rules,
                },
            ));
        }

        let Converter {
            typography,
            typography_queries,
            ..
        } = converter;
        let contract = theme.as_ref().map(|theme| &theme.metadata.contract);
        let composition = contract.and_then(|contract| contract.composition);
        let css_output = contract.and_then(|contract| contract.css_output);

        bodies.insert(call.span.start, body);
        styles.extend(
            definition
                .styles
                .iter()
                .map(|style| with_contract(style, composition, css_output)),
        );

        if failed {
            continue;
        }

        let unchanged = match (&dynamic, original) {
            (Some(read), _) => std::ptr::eq(read.body, body),
            (None, Some(Expression::ObjectExpression(object))) => {
                std::ptr::eq(object.as_ref(), body)
            }
            (None, _) => false,
        };
        let portable = (options.compiler == Some(false)).then(|| {
            if explicit.is_some() {
                return Some(Arc::from(format!("z-style-{definition_id}")));
            }

            let first = definition.styles.first()?;

            if dynamic.is_some()
                || expanded.is_some()
                || entries.is_some_and(|entries| entries.is_empty())
                || (first.declarations.is_empty()
                    && first.rules.is_none()
                    && first.targets.is_none())
            {
                return None;
            }

            Some(Arc::from(identity::style(first, css_namespace.as_deref())))
        });
        let (static_recipe, dynamic_recipe) = match target_recipe {
            Some((true, recipe)) => (Some(recipe), None),
            Some((false, recipe)) => (None, Some(recipe)),
            None => (None, None),
        };

        calls.push(Call {
            body: (!unchanged).then_some(body),
            css_name: Some(css_name),
            css_namespace,
            dynamic_recipe,
            end: call.span.end,
            identity: selectors.identities.get(&call.span.start).cloned(),
            keywords: dynamic
                .as_ref()
                .map(|read| read.keywords.clone())
                .unwrap_or_default(),
            name,
            output: bound.and_then(|(_, output)| output),
            portable: portable.flatten(),
            recipe: expanded.as_ref().map(|expanded| expanded.recipe.clone()),
            recipe_types: expanded.as_ref().map(|expanded| expanded.types.clone()),
            shorthands: contract.and_then(|contract| contract.shorthands.clone()),
            slots: dynamic.as_ref().map(|read| read.slots.clone()),
            start: call.span.start,
            static_recipe,
            typography: (!typography.is_empty()).then_some(typography),
            typography_queries: (!typography_queries.is_empty()).then_some(typography_queries),
            values_type: dynamic.as_ref().map(|read| {
                let span = read.type_annotation.span();

                Arc::from(
                    options
                        .source
                        .get(span.start as usize..span.end as usize)
                        .unwrap_or_default(),
                )
            }),
            ..Call::default()
        });
    }

    if options.target != Target::Native {
        let collected = compositions::collect(compositions::Options {
            allocator,
            calls: &calls,
            identity: &namespace,
            links: context.map(|context| &context.links),
            offsets: &parsed.offsets,
            program,
            scopes: themes.as_ref().map(|themes| &themes.scope_applications),
            semantic: &parsed.semantic,
            source: options.source,
            styles: &styles,
        });

        match collected {
            Ok(entries) => {
                for (position, entry) in entries.into_iter().enumerate() {
                    let authored = parsed
                        .names()
                        .get(entry.call.start)
                        .filter(|name| *name != "style")
                        .unwrap_or("composition");
                    let css_name = format!(
                        "{authored}-{position}-{}",
                        entry.call.css_name.as_deref().unwrap_or("style")
                    );

                    for (case, (mut value, _)) in entry.cases.iter().cloned().enumerate() {
                        value.css_name = Some(Arc::from(format!("{css_name}-{case}")));
                        calls.push(value);
                    }

                    let mut composed = entry.call;

                    composed.css_name = Some(Arc::from(css_name));
                    calls.push(composed);
                    styles.extend(entry.cases.into_iter().map(|(_, style)| style));
                    styles.push(entry.style);
                }
            }
            Err(error) => reporter.unsupported(error)?,
        }
    }

    if let Some(themes) = &themes
        && reporter.len() == 0
    {
        for (start, token) in &themes.tokens {
            let compiled = calls
                .iter()
                .map(|call| (call.start, call.end))
                .chain(
                    contributions
                        .calls
                        .iter()
                        .map(|call| (call.start, call.end)),
                )
                .any(|(call_start, call_end)| *start >= call_start && token.end <= call_end);

            if !statics.is_used(*start)
                && !themes.static_tokens.iter().any(|node| node.start == *start)
                && !compiled
            {
                reporter.report(
                    Code::UnsupportedSyntax,
                    "Theme references require a compiled style declaration.",
                    Some(Span::new(*start, token.end)),
                );
            }
        }
    }

    let mut contribution_starts = variables.registration_starts.clone();
    let scopes: Vec<(Arc<str>, Scope)> = themes
        .iter()
        .flat_map(|themes| themes.themes.iter())
        .map(|(name, theme)| (Arc::clone(name), Scope::Definition(theme.metadata.clone())))
        .collect();
    let contribution_data = (|| -> Result<Vec<web::Definition>> {
        for (index, registration) in variables.registrations.iter().enumerate() {
            let span = variables
                .registration_locations
                .get(index)
                .copied()
                .unwrap_or_default();
            let css = css::compile(
                &css::Options {
                    contributions: std::slice::from_ref(registration),
                    ..css::Options::default()
                },
                None,
            )
            .map_err(|error| invalid(&error.text(), span))?
            .css;

            at_rules::validate(&css, options.module_id)
                .map_err(|error| invalid(&error.text(), span))?;
        }

        let mut data = variables.registrations.clone();
        let empty = IndexMap::default();
        let resolve =
            |node: &'a Expression<'a>| statics.resolve(node, &static_calls, &mut Vec::new());

        data.extend(contributions::extract(
            &mut contributions,
            themes.as_ref().map_or(&empty, |themes| &themes.tokens),
            &mut contribution_starts,
            &resolve,
            &parsed.offsets,
        )?);

        for call in themes.iter().flat_map(|themes| themes.calls.iter()) {
            let layers = call
                .options
                .as_ref()
                .and_then(|options| options.get("layers"))
                .filter(|layers| truthy(layers));

            if let Some(layers) = layers {
                let names = match layers {
                    Data::Array(names) => names
                        .iter()
                        .map(|name| Arc::from(name.to_js_string()))
                        .collect(),
                    other => vec![Arc::from(other.to_js_string())],
                };

                data.push(web::Definition {
                    kind: web::Kind::Layers { names },
                    within: Vec::new(),
                });
            }
        }

        if !data.is_empty() {
            let rendered = css::compile(
                &css::Options {
                    contributions: &data,
                    vars: themes.as_ref().map(|_| scopes.as_slice()),
                    ..css::Options::default()
                },
                None,
            )
            .map_err(|error| Error::message(error.text()))?
            .css;
            // Without a graph, no host relocates relative assets.
            if context.is_none() {
                at_rules::transform_with(
                    &Transform {
                        code: &rendered,
                        filename: options.module_id,
                        ..Transform::default()
                    },
                    &mut Relative,
                )?;
            } else {
                at_rules::validate(&rendered, options.module_id)?;
            }
        }

        Ok(data)
    })();
    let contribution_data = match contribution_data {
        Ok(data) => data,
        Err(Error::Themes { message, span }) => {
            reporter.report(Code::UnsupportedSyntax, message, Some(span));
            Vec::new()
        }
        Err(error) => {
            let span = contributions
                .calls
                .first()
                .map(|call| Span::new(call.start, call.end));

            reporter.report(Code::UnsupportedSyntax, error.text(), span);
            Vec::new()
        }
    };

    if let Some(themes) = &themes {
        for token in &themes.static_tokens {
            if !statics.is_used(token.value_start) {
                reporter.report(
                    Code::UnsupportedSyntax,
                    "Token references must be direct property values in bound theme style calls.",
                    Some(Span::new(token.start, token.end)),
                );
            }
        }
    }

    if reporter.len() > 0 {
        return Err(reporter.fail());
    }

    let theme_exports = match context {
        Some(_) => {
            let mut exports = themes
                .as_ref()
                .map(|themes| themes.exports.clone())
                .unwrap_or_default();

            for (name, link) in selectors.exports.iter() {
                let link = exported_style(link, &calls, &styles, &mut themes)?;

                exports.insert(Arc::clone(name), link);
            }

            for (name, link) in contributions.exports().iter() {
                exports.insert(Arc::clone(name), link.clone());
            }

            for (name, link) in variables.exports.iter() {
                exports.insert(Arc::clone(name), link.clone());
            }

            Some(exports)
        }
        None => None,
    };
    let labels = labels(&calls, &styles);

    calls.sort_by_key(|call| call.start);

    if options.target == Target::Native
        && let Some(themes) = themes.as_mut()
    {
        for call in &mut calls {
            call.native_context = themes.native_context(call.start, call.end)?;
        }
    }

    let namespaces = contribution_data
        .iter()
        .filter_map(|value| match &value.kind {
            web::Kind::Namespace(definition) => Some(definition.clone()),
            _ => None,
        })
        .collect();
    let (contribution_starts, contribution_data) = if contribution_data.is_empty() {
        (Vec::new(), contribution_data)
    } else {
        (contribution_starts, contribution_data)
    };
    let Some(themes) = themes else {
        return Ok(Extracted {
            calls,
            collected_themes: false,
            contribution_calls: contributions.calls,
            contribution_starts,
            contributions: contribution_data,
            namespaces,
            native_vars: Vec::new(),
            static_theme_references: Vec::new(),
            styles: style::Definition {
                labels: Some(Arc::new(labels)),
                styles,
            },
            theme_aliases: Vec::new(),
            theme_appearances: Vec::new(),
            theme_calls: Vec::new(),
            theme_exports,
            theme_references: Vec::new(),
            theme_scripts: Vec::new(),
            theme_selections: Vec::new(),
            variable_calls: variables.calls,
            vars: Record::new(),
        });
    };
    let static_theme_references = themes
        .static_tokens
        .iter()
        .filter_map(|node| {
            let token = themes.tokens.get(&node.start)?;

            Some(StaticThemeReference {
                end: node.end,
                start: node.start,
                value: web_themes::Themes::new().serialize(&token.reference),
            })
        })
        .collect();
    let selections = if options.target == Target::Native {
        &themes.selection_uses
    } else {
        &themes.selections
    };

    Ok(Extracted {
        calls,
        collected_themes: true,
        contribution_calls: contributions.calls,
        contribution_starts,
        contributions: contribution_data,
        namespaces,
        native_vars: themes.vars_reads,
        static_theme_references,
        styles: style::Definition {
            labels: Some(Arc::new(labels)),
            styles,
        },
        theme_aliases: themes.aliases,
        theme_appearances: themes.appearances.into_iter().collect(),
        theme_calls: themes.calls,
        theme_exports,
        theme_references: themes.references,
        theme_scripts: themes.scripts.into_iter().collect(),
        theme_selections: selections.iter().cloned().collect(),
        variable_calls: variables.calls,
        vars: themes.themes,
    })
}

/// Rejects relative import and `url()` assets, which only a graph host can relocate.
struct Relative;

impl Relative {
    /// Fails for a nonempty URL that is neither root-relative, a fragment or query, nor absolute.
    fn check(url: &str) -> Result<()> {
        if url.is_empty() || absolute(url) {
            return Ok(());
        }

        Err(Error::message(
            "Relative contribution assets require Graph.compile and a relocation host.",
        ))
    }
}

impl<'i> Visitor<'i> for Relative {
    type Error = Error;

    fn visit_types(&self) -> VisitTypes {
        VisitTypes::RULES | VisitTypes::URLS
    }

    fn visit_rule(&mut self, rule: &mut CssRule<'i>) -> Result<()> {
        if let CssRule::Import(import) = &*rule {
            Self::check(&import.url)?;
        }

        rule.visit_children(self)
    }

    fn visit_url(&mut self, url: &mut Url<'i>) -> Result<()> {
        Self::check(&url.url)
    }
}

/// Reports `Style.InvalidError` diagnostics as invalid literals at their locations.
fn invalid_literals(reporter: &mut Reporter<'_>, diagnostics: Vec<style::Diagnostic>, call: Span) {
    for diagnostic in diagnostics {
        let (start, end) = diagnostic.location.as_ref().map_or_else(
            || {
                (
                    reporter.offsets.utf16(call.start),
                    reporter.offsets.utf16(call.end),
                )
            },
            |location| (location.start, location.end),
        );

        reporter.diagnostics.push(Diagnostic {
            code: Code::InvalidLiteral,
            end,
            message: diagnostic.message,
            source: Arc::clone(&reporter.module_id),
            start,
        });
    }
}

/// Applies the composition and CSS output a configuration contract assigns to its styles.
fn with_contract(
    style: &Arc<NamedStyle>,
    composition: Option<token::Composition>,
    css_output: Option<token::CssOutput>,
) -> Arc<NamedStyle> {
    if composition.is_none() && css_output.is_none() {
        return Arc::clone(style);
    }

    let mut copy = (**style).clone();

    if composition.is_some() {
        copy.composition = composition;
    }

    if css_output.is_some() {
        copy.css_output = css_output;
    }

    Arc::new(copy)
}

/// Whether a value is truthy in JavaScript.
fn truthy(value: &Data) -> bool {
    match value {
        Data::Bool(value) => *value,
        Data::Null | Data::Undefined => false,
        Data::Number(number) => *number != 0.0 && !number.is_nan(),
        Data::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// Readable class labels: each style takes its call's CSS name and namespace, found by
/// trimming `-` segments from the style name.
fn labels(calls: &[Call<'_>], styles: &[Arc<NamedStyle>]) -> style::Labels {
    let mut by_name: FxHashMap<&str, &Call<'_>> =
        FxHashMap::with_capacity_and_hasher(calls.len(), FxBuildHasher);

    for call in calls {
        by_name.insert(&call.name, call);
    }

    let mut labels = style::Labels::with_capacity_and_hasher(styles.len(), FxBuildHasher);

    for style in styles {
        let mut name: &str = &style.name;
        let mut call = by_name.get(name).copied();

        while call.is_none()
            && let Some(index) = name.rfind('-')
        {
            name = name.get(..index).unwrap_or_default();
            call = by_name.get(name).copied();
        }

        let label = match call {
            Some(call) => style::Label {
                name: match &call.css_name {
                    Some(css_name) if !css_name.is_empty() => {
                        let suffix = style.name.get(call.name.len()..).unwrap_or_default();

                        if suffix.is_empty() {
                            Arc::clone(css_name)
                        } else {
                            let mut name = String::with_capacity(css_name.len() + suffix.len());

                            name.push_str(css_name);
                            name.push_str(suffix);
                            Arc::from(name)
                        }
                    }
                    _ => Arc::clone(&style.name),
                },
                namespace: call.css_namespace.clone(),
            },
            None => style::Label {
                name: Arc::clone(&style.name),
                namespace: None,
            },
        };

        labels.insert(Arc::clone(&style.name), label);
    }

    labels
}
