//! Links a closed graph of source modules without executing code or reading files.
//!
//! One compilation parses each module at most once, into an arena that lives only as long as the
//! compilation. What a later compilation of the same graph may reuse is owned data: detached
//! extraction results, contracts, and transform outputs. An incremental compiler therefore keeps
//! no syntax trees between snapshots, and a module whose extraction is reused but whose output
//! must change is extracted again, which yields the same result for the same inputs.

use std::cell::OnceCell;
use std::sync::Arc;

use indexmap::{IndexMap, IndexSet};
use oxc_allocator::{Allocator, CloneIn};
use oxc_ast::AstKind;
use oxc_ast::ast::{
    BindingPattern, Declaration, ExportDefaultDeclarationKind, ExportSpecifier, Expression,
    ImportDeclarationSpecifier, ImportOrExportKind, ModuleExportName, ObjectPropertyKind, Program,
    PropertyKind, Statement, StringLiteral, UnaryOperator,
};
use oxc_ast_visit::{Visit, VisitMut};
use oxc_span::{GetSpan, Span};
use rustc_hash::{FxBuildHasher, FxHashMap, FxHashSet};

use crate::compiler::internal::contract::{self, Configuration, Library};
use crate::compiler::internal::contributions::FACTORIES;
use crate::compiler::internal::stylesheets::{self, Rendered, Section};
use crate::compiler::internal::syntax::{self, Parsed};
use crate::compiler::internal::themes::{self, Link, LinkKind, Owner, VarsRead};
use crate::compiler::internal::{identifiers, literals, native_vars, relative, statics, vars};
use crate::compiler::native;
use crate::compiler::source::{self, Code, Diagnostic, ExtractError, Extracted, Target};
use crate::compiler::transform::{self, Owners};
use crate::data::Data;
use crate::error::{Error, Result};
use crate::internal::theme::Definition;
use crate::internal::token::{Composition, CssOutput, Reference};
use crate::internal::{identity, variable_sets};
use crate::js::{self, Record, Utf16Index};
use crate::react_native::internal::scalar;
use crate::react_native::style_sheet;
use crate::style::{self, NamedStyle};
use crate::web::css;
use crate::web::internal::class_name::{Registry, Visibility};
use crate::web::internal::contributions::{Definition as Contribution, Kind as ContributionKind};
use crate::web::internal::namespace;
use crate::web::internal::themes::{self as theme_rules, Rule as ThemeRule, Scope, Shared, Themes};

/// An ordered record keyed by module identity or name.
pub type Map<V> = IndexMap<Arc<str>, V, FxBuildHasher>;

/// Inputs of one graph compilation.
#[derive(Clone, Debug, Default)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "Each flag is an independent host option."
)]
pub struct Options {
    /// Lets modules reuse shared rule names from unrelated modules of this one graph.
    pub complete: bool,
    /// Rewrites authoring calls. `Some(false)` emits CSS for unchanged source.
    pub compiler: Option<bool>,
    /// Whether compiled applications can be combined with one another.
    pub composition: Option<Composition>,
    /// Serialized library contracts keyed by host-resolved module identity.
    pub contracts: Option<Map<Arc<str>>>,
    /// Default CSS representation for definitions without an explicit mode.
    pub css_output: Option<CssOutput>,
    /// Stable declaration names for CSS-only development updates.
    pub development: bool,
    /// Host entrypoint that emits owned stylesheet effects without packed contracts.
    pub entry: Option<Arc<str>>,
    /// Host-resolved static imports keyed by module identity and specifier. `None` targets are
    /// externals. Omit for closed relative-graph resolution.
    pub imports: Option<Map<Map<Option<Arc<str>>>>>,
    /// An untyped host supplied a default CSS output that is neither atomic nor grouped. Each
    /// web module's CSS compilation reports it, as `Css.compile` validates the option first.
    pub invalid_css_output: bool,
    /// Publishes only configuration catalogs as contracts, for hosts that read module code,
    /// stylesheets, and catalogs but never publish contracts.
    pub lean: bool,
    /// Complete source graph keyed by stable package-relative module identities.
    pub modules: Map<Arc<str>>,
    /// Native output context. `None` compiles web modules and CSS.
    pub native: Option<NativeOptions>,
    /// Every module that may interpolate a style definition into a selector is in the graph,
    /// and no consumer outside it reads published contracts. Production class lists then carry
    /// only the identity classes those selectors reference.
    pub references: bool,
    /// Reset stylesheet supplied by the host, ordered before authored layers.
    pub reset: Option<Arc<str>>,
    /// Publishes variable scopes once with shared rules, for CSS-only hosts.
    pub shared: Option<Shared>,
}

/// The native target of a graph: every `Native.compile` option except the module identity and
/// source.
///
/// Optional fields record whether the host supplied the option, since a different set of
/// supplied options invalidates the incremental cache as it does in TypeScript.
#[derive(Clone, Debug)]
pub struct NativeOptions {
    /// Scheme compiled into each module's callables.
    pub color_scheme: Option<Arc<str>>,
    /// Retains every set and scheme for render-local selection.
    pub contextual: Option<bool>,
    /// Authored `fonts` option, `Data::Undefined` when omitted.
    pub fonts: Data,
    /// Authored `platform` option, `Data::Undefined` when omitted.
    pub platform: Data,
    /// Babel emission: omits type annotations, and owners publish every exported profile.
    pub runtime: bool,
    /// Label selected from `vars`.
    pub set: Option<Arc<str>>,
    /// Authored `units` option, `Data::Undefined` when omitted.
    pub units: Data,
    /// Compatible sets by label. Entries compare by identity across compilations.
    pub vars: Option<Record<Arc<Definition>>>,
}

impl Default for NativeOptions {
    fn default() -> Self {
        Self {
            color_scheme: None,
            contextual: None,
            fonts: Data::Undefined,
            platform: Data::Undefined,
            runtime: false,
            set: None,
            units: Data::Undefined,
            vars: None,
        }
    }
}

/// One compiled module of a graph.
#[derive(Clone, Debug)]
pub enum Compiled {
    /// Native source with adapter edits.
    Native(Arc<native::Output>),
    /// Web source with its stylesheet.
    Web(Arc<transform::Output>),
}

impl Compiled {
    /// Whether both hold the same output value, which unchanged modules keep across
    /// compilations.
    pub fn same(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Native(left), Self::Native(right)) => Arc::ptr_eq(left, right),
            (Self::Web(left), Self::Web(right)) => Arc::ptr_eq(left, right),
            _ => false,
        }
    }

    /// The web transform output, absent for native modules.
    pub fn web(&self) -> Option<&Arc<transform::Output>> {
        match self {
            Self::Native(_) => None,
            Self::Web(output) => Some(output),
        }
    }
}

/// A packed or reset stylesheet resource loaded independently of module CSS.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Resource {
    /// Stable identity for deduplication across scoped outputs.
    pub id: String,
    /// Rendered stylesheet.
    pub rendered: Rendered,
}

/// Compiled modules and their direct source dependencies.
#[derive(Clone, Debug, Default)]
pub struct Output {
    /// Versioned compiler-only JSON per module, published beside the compiled entrypoint.
    pub contracts: Map<String>,
    /// Direct static runtime source and library-contract dependencies, in extraction order.
    pub dependencies: Map<Arc<[Arc<str>]>>,
    /// Rewritten modules and their stylesheets, in module identity order. Unchanged modules keep
    /// the output of the compilation that produced them.
    pub modules: Map<Compiled>,
    /// Packed resources deduplicated by the host across scoped source outputs.
    pub packed: Vec<Resource>,
    /// Independently loaded reset for module-based hosts.
    pub reset: Option<Resource>,
    /// Shared contributions and responsive token defaults, present when they emit CSS.
    pub shared: Option<Rendered>,
}

/// Compiles supplied modules with shared theme contracts and dependency metadata.
///
/// # Errors
///
/// Returns `Source.ExtractError` for unsupported graphs and source, and `Css.CompileError` from
/// emission. Native graphs return `Native.CompileError` for a reset, disabled rewriting, or
/// unsupported native source, and the table errors of [`native::compile`].
pub fn compile(options: &Options) -> Result<Arc<Output>> {
    Graph::default().compile(options)
}

/// An incremental compiler that reuses unaffected work across snapshots of one graph.
#[derive(Default)]
pub struct Graph {
    previous: Option<Cache>,
}

impl Graph {
    /// Compiles a complete source snapshot, reusing unaffected work across calls. A failed
    /// compilation keeps the state of the last successful one.
    ///
    /// # Errors
    ///
    /// Returns the errors of [`compile`].
    pub fn compile(&mut self, options: &Options) -> Result<Arc<Output>> {
        match build(options, self.previous.as_ref())? {
            Some(next) => {
                let result = Arc::clone(&next.result);

                self.previous = Some(next);
                Ok(result)
            }
            None => Ok(self
                .previous
                .as_ref()
                .map(|previous| Arc::clone(&previous.result))
                .unwrap_or_default()),
        }
    }
}

/// Owned extraction data that the graph links, publishes, and caches.
#[derive(Debug, Default, PartialEq)]
struct Module {
    calls: Vec<CallSummary>,
    contribution_starts: Vec<u32>,
    contributions: Vec<Contribution>,
    literals: Record<Arc<str>>,
    namespaces: Vec<namespace::Definition>,
    native_vars: Vec<VarsRead>,
    /// Whether exports supply neither constants nor authoring links.
    opaque: bool,
    styles: style::Definition,
    theme_appearances: Vec<Arc<str>>,
    theme_calls: Vec<themes::Call>,
    theme_exports: Record<Link>,
    theme_scripts: Vec<Arc<str>>,
    theme_selections: Vec<Arc<str>>,
    variable_calls: Vec<vars::Call>,
    vars: Record<Arc<Definition>>,
}

#[derive(Debug, PartialEq)]
struct CallSummary {
    composition: bool,
    composition_case: bool,
    identity: Option<Arc<str>>,
    inputs: Vec<Arc<str>>,
    name: Arc<str>,
    portable: Option<Arc<str>>,
    runtime_composition: bool,
}

impl Module {
    fn detach(extracted: &Extracted<'_>) -> Self {
        Self {
            calls: extracted
                .calls
                .iter()
                .map(|call| CallSummary {
                    composition: call.composition.is_some(),
                    composition_case: call.composition_case,
                    identity: call.identity.clone(),
                    inputs: call
                        .runtime_composition
                        .iter()
                        .flatten()
                        .map(|input| Arc::clone(&input.name))
                        .collect(),
                    name: Arc::clone(&call.name),
                    portable: call.portable.clone(),
                    runtime_composition: call.runtime_composition.is_some(),
                })
                .collect(),
            contribution_starts: extracted.contribution_starts.clone(),
            contributions: extracted.contributions.clone(),
            literals: Record::new(),
            namespaces: extracted.namespaces.clone(),
            native_vars: extracted.native_vars.clone(),
            opaque: false,
            styles: extracted.styles.clone(),
            theme_appearances: extracted.theme_appearances.clone(),
            theme_calls: extracted.theme_calls.clone(),
            theme_exports: extracted.theme_exports.clone().unwrap_or_default(),
            theme_scripts: extracted.theme_scripts.clone(),
            theme_selections: extracted.theme_selections.clone(),
            variable_calls: extracted.variable_calls.clone(),
            vars: extracted.vars.clone(),
        }
    }
}

/// A dependency a cached extraction read, compared by identity.
#[derive(Clone)]
enum Input {
    Library(Arc<Library>),
    Module(Arc<Module>),
    /// A source whose exports cannot supply constants or authoring links.
    Runtime,
}

#[derive(Clone)]
struct Extraction {
    dependencies: Arc<[Arc<str>]>,
    extracted: Arc<Module>,
    inputs: Vec<(Arc<str>, Input)>,
    resolution: String,
    source: Arc<str>,
}

#[derive(Clone)]
struct Transformed {
    classes: Vec<(Arc<str>, Option<Arc<str>>)>,
    extracted: Arc<Module>,
    /// The identity classes of this module's calls that selectors reference, when known.
    markers: Option<Box<[Arc<str>]>>,
    output: Arc<transform::Output>,
    owners: Arc<[(Arc<str>, usize)]>,
    schemes: bool,
    themes: Record<Arc<Definition>>,
}

/// Token resources a lean graph emitted once for the references of its deferred modules.
struct Scoped {
    /// Replayed references in canonical order.
    references: Box<[Arc<Reference>]>,
    resources: Box<[theme_rules::Resource]>,
}

#[expect(
    clippy::struct_excessive_bools,
    reason = "Each flag records one independent option of the cached compilation."
)]
struct Cache {
    composition: Option<Composition>,
    contracts: String,
    css_output: Option<CssOutput>,
    development: bool,
    entry: Option<Arc<str>>,
    extracted: Map<Arc<Module>>,
    lean: bool,
    libraries: Map<Arc<Library>>,
    native: Option<NativeOptions>,
    referenced: Option<Arc<FxHashSet<Arc<str>>>>,
    references: bool,
    renders: Vec<Arc<(Vec<Section>, Rendered)>>,
    reset: Option<Arc<str>>,
    resolutions: Map<String>,
    result: Arc<Output>,
    retained: Map<Extraction>,
    rewrite: bool,
    schemes: bool,
    scoped: Option<Arc<Scoped>>,
    shared: Option<Shared>,
    sources: Map<Arc<str>>,
    themes: Record<Arc<Definition>>,
    transformed: Map<Transformed>,
}

/// The bound on cached extractions and transforms, evicting the earliest cached module. A recompile
/// updates a module in place, since reordering a map costs its length per module, and the previous
/// compilation supplies every module it held regardless of this bound.
const RETAINED: usize = 256;

/// Evicts the earliest cached modules past [`RETAINED`] once per compilation, as removing each
/// from the front of a map shifts every entry after it.
fn bounded<V>(mut cache: Map<V>) -> Map<V> {
    if let Some(excess) = cache.len().checked_sub(RETAINED) {
        cache.drain(..excess);
    }

    cache
}

/// `Array.prototype.sort` order: UTF-16 code units.
fn sort(values: &mut [Arc<str>]) {
    values.sort_by(|left, right| js::code_units(left).cmp(js::code_units(right)));
}

/// A canonical signature of an ordered record, for equality only.
fn signature<'v>(entries: impl Iterator<Item = (&'v str, Option<&'v str>)>) -> String {
    let mut entries: Vec<_> = entries.collect();
    let mut output = String::new();

    entries.sort_by(|left, right| left.0.cmp(right.0));

    for (key, value) in entries {
        js::write_string(&mut output, key);
        output.push(':');

        match value {
            Some(value) => js::write_string(&mut output, value),
            None => output.push_str("null"),
        }

        output.push(',');
    }

    output
}

/// JavaScript truthiness, as `Boolean(value)` reads it.
fn truthy(value: &Data) -> bool {
    match value {
        Data::Bool(value) => *value,
        Data::Null | Data::Undefined => false,
        Data::Number(value) => *value != 0.0 && !value.is_nan(),
        Data::String(value) => !value.is_empty(),
        _ => true,
    }
}

/// Whether a nested native mapping is unchanged, comparing presence, key count, and each entry
/// with `===`, as the TypeScript cache compares `fonts` and `units`.
fn same_mapping(previous: &Data, next: &Data) -> bool {
    let entries = |value: &Data| -> Vec<(Arc<str>, Data)> {
        match value {
            Data::Object(object) => object
                .iter()
                .map(|(key, value)| (Arc::clone(key), value.clone()))
                .collect(),
            Data::Array(items) => items
                .iter()
                .enumerate()
                .map(|(index, value)| (Arc::from(index.to_string()), value.clone()))
                .collect(),
            _ => Vec::new(),
        }
    };
    let previous_entries = entries(previous);
    let next_entries = entries(next);

    truthy(previous) == truthy(next)
        && previous_entries.len() == next_entries.len()
        && previous_entries.iter().all(|(name, entry)| {
            next_entries
                .iter()
                .find(|(key, _)| key == name)
                .is_some_and(|(_, value)| value.same(entry))
        })
}

/// Whether a cache built for `previous` native options can serve `next`, comparing supplied
/// options with `===` and nested mappings and sets by entry.
fn same_native(previous: Option<&NativeOptions>, next: Option<&NativeOptions>) -> bool {
    let (Some(previous), Some(next)) = (previous, next) else {
        return previous.is_none() && next.is_none();
    };
    let same_vars = match (&previous.vars, &next.vars) {
        (None, None) => true,
        (Some(left), Some(right)) => {
            left.len() == right.len()
                && left.iter().all(|(name, definition)| {
                    right
                        .get(name)
                        .is_some_and(|other| Arc::ptr_eq(definition, other))
                })
        }
        _ => false,
    };

    previous.runtime == next.runtime
        && previous.color_scheme == next.color_scheme
        && previous.contextual == next.contextual
        && previous.set == next.set
        && previous.platform.same(&next.platform)
        && previous.fonts.is_undefined() == next.fonts.is_undefined()
        && same_mapping(&previous.fonts, &next.fonts)
        && previous.units.is_undefined() == next.units.is_undefined()
        && same_mapping(&previous.units, &next.units)
        && same_vars
}

fn build(options: &Options, cache: Option<&Cache>) -> Result<Option<Cache>> {
    let cache = cache.filter(|cache| same_native(cache.native.as_ref(), options.native.as_ref()));

    if options.native.is_some() {
        if options.reset.is_some() {
            return Err(Error::Native(
                "The CSS reset is only supported by web builds.".to_owned(),
            ));
        }

        if options.compiler == Some(false) {
            return Err(Error::Native(
                "Native graph compilation requires source rewriting.".to_owned(),
            ));
        }
    }

    let rewrite = options.compiler != Some(false);
    let cache = cache.filter(|cache| {
        cache.rewrite == rewrite
            && cache.reset == options.reset
            && cache.css_output == options.css_output
            && !options.invalid_css_output
            && cache.composition == options.composition
            && cache.shared == options.shared
            && cache.entry.is_none() == options.entry.is_none()
            && cache.lean == options.lean
            && cache.references == options.references
    });
    let mut ids: Vec<Arc<str>> = options.modules.keys().cloned().collect();

    sort(&mut ids);

    let contracts = signature(
        options
            .contracts
            .iter()
            .flat_map(|contracts| contracts.iter())
            .map(|(id, text)| (&**id, Some(&**text))),
    );
    let mut resolution_ids: Vec<Arc<str>> = ids
        .iter()
        .cloned()
        .chain(
            options
                .imports
                .iter()
                .flat_map(|imports| imports.keys().cloned()),
        )
        .collect::<IndexSet<_, FxBuildHasher>>()
        .into_iter()
        .collect();

    sort(&mut resolution_ids);

    let resolutions: Map<String> = resolution_ids
        .into_iter()
        .map(|id| {
            let resolution = match &options.imports {
                None => "relative".to_owned(),
                Some(imports) => signature(
                    imports
                        .get(&id)
                        .iter()
                        .flat_map(|imports| imports.iter())
                        .map(|(specifier, target)| (&**specifier, target.as_deref())),
                ),
            };

            (id, resolution)
        })
        .collect();
    // Host resolutions remain explicit when generated modules enter or leave the graph.
    let previous = cache.filter(|cache| {
        cache.contracts == contracts
            && cache.development == options.development
            && (options.imports.is_some()
                || (ids.len() == cache.sources.len()
                    && ids.iter().all(|id| cache.sources.contains_key(id))))
    });

    if let Some(previous) = previous
        && previous.entry == options.entry
        && ids.len() == previous.sources.len()
        && resolutions == previous.resolutions
        && ids.iter().all(|id| {
            previous
                .sources
                .get(id)
                .is_some_and(|source| options.modules.get(id) == Some(source))
        })
    {
        return Ok(None);
    }

    let allocators: Vec<Allocator> = ids.iter().map(|_| Allocator::default()).collect();
    let parsed: Vec<OnceCell<Parsed<'_>>> = ids.iter().map(|_| OnceCell::new()).collect();
    let offsets: Vec<OnceCell<Utf16Index>> = ids.iter().map(|_| OnceCell::new()).collect();
    let mut graph = Build {
        allocators: &allocators,
        constants: FxHashMap::default(),
        dependencies: Map::default(),
        emitted_rules: FxHashMap::default(),
        extracted: Map::default(),
        fresh: FxHashMap::default(),
        identifiers: FxHashMap::default(),
        indexes: ids
            .iter()
            .enumerate()
            .map(|(index, id)| (Arc::clone(id), index))
            .collect(),
        libraries: Map::default(),
        offsets: &offsets,
        options,
        owners: Owners::default(),
        parsed: &parsed,
        previous,
        renders: Vec::new(),
        resolutions,
        retained: previous
            .map(|previous| previous.retained.clone())
            .unwrap_or_default(),
        themes: Record::new(),
        variable_slots: FxHashMap::default(),
        visiting: FxHashSet::default(),
    };

    graph.libraries()?;

    for id in &ids {
        graph.visit(id)?;
    }

    match &options.native {
        Some(native) => graph.native(native, &ids, contracts).map(Some),
        None => graph.web(&ids, rewrite, contracts).map(Some),
    }
}

struct Slot {
    binding: String,
    domain: &'static str,
    owner: String,
}

struct Build<'p, 'a> {
    allocators: &'a [Allocator],
    constants: FxHashMap<(Arc<str>, String), Option<&'a Expression<'a>>>,
    dependencies: Map<Arc<[Arc<str>]>>,
    emitted_rules: FxHashMap<String, (String, Arc<str>)>,
    extracted: Map<Arc<Module>>,
    fresh: FxHashMap<Arc<str>, Extracted<'a>>,
    /// Generated-prefix identifiers of the modules this compilation extracted, for native naming.
    identifiers: FxHashMap<Arc<str>, FxHashSet<Arc<str>>>,
    indexes: FxHashMap<Arc<str>, usize>,
    libraries: Map<Arc<Library>>,
    offsets: &'p [OnceCell<Utf16Index>],
    options: &'a Options,
    owners: Owners,
    parsed: &'p [OnceCell<Parsed<'a>>],
    previous: Option<&'p Cache>,
    /// Shared stylesheets this compilation rendered, with the sections each rendered.
    renders: Vec<Arc<(Vec<Section>, Rendered)>>,
    resolutions: Map<String>,
    retained: Map<Extraction>,
    themes: Record<Arc<Definition>>,
    variable_slots: FxHashMap<String, Slot>,
    visiting: FxHashSet<Arc<str>>,
}

/// The parts of a module that its linked extraction reads from the graph.
struct Linked<'a> {
    extracted: Extracted<'a>,
    imports: Arc<[Arc<str>]>,
    literals: Record<Arc<str>>,
    opaque: bool,
}

/// Finds the first dynamic import a closed relative graph cannot follow.
struct Imports {
    dynamic: Option<Span>,
}

impl<'a> Visit<'a> for Imports {
    fn enter_node(&mut self, kind: AstKind<'a>) {
        if let AstKind::ImportExpression(node) = kind
            && self.dynamic.is_none()
        {
            let relative = match &node.source {
                Expression::StringLiteral(literal) => literal.value.starts_with('.'),
                _ => true,
            };

            if relative {
                self.dynamic = Some(node.span);
            }
        }
    }
}

/// Moves every span of a copied constant to the import that reads it.
struct Relocate(Span);

impl VisitMut<'_> for Relocate {
    fn visit_span(&mut self, span: &mut Span) {
        *span = self.0;
    }
}

/// Whether a constant is literal JSON-like data, as the TypeScript graph accepts it.
fn literal(node: &Expression<'_>, depth: usize) -> bool {
    if depth > 64 {
        return false;
    }

    match node {
        Expression::StringLiteral(_)
        | Expression::NumericLiteral(_)
        | Expression::BooleanLiteral(_)
        | Expression::NullLiteral(_) => true,
        Expression::UnaryExpression(unary) => {
            matches!(
                unary.operator,
                UnaryOperator::UnaryPlus | UnaryOperator::UnaryNegation
            ) && matches!(unary.argument, Expression::NumericLiteral(_))
        }
        Expression::TemplateLiteral(template) => template.expressions.is_empty(),
        Expression::ArrayExpression(array) => array.elements.iter().all(|element| {
            element
                .as_expression()
                .is_some_and(|element| literal(element, depth + 1))
        }),
        Expression::ObjectExpression(object) => object.properties.iter().all(|property| {
            let ObjectPropertyKind::ObjectProperty(property) = property else {
                return false;
            };

            !property.method
                && property.kind == PropertyKind::Init
                && (!property.computed || statics::key_is_literal(&property.key))
                && literal(&property.value, depth + 1)
        }),
        _ => false,
    }
}

fn export_name(name: &ModuleExportName<'_>) -> String {
    name.name().to_string()
}

/// One ESTree `ExportNamedDeclaration`, which oxc splits into declaration, local, and re-export
/// statements.
struct NamedExport<'s, 'a> {
    declaration: Option<&'s Declaration<'a>>,
    export_kind: ImportOrExportKind,
    source: Option<&'s StringLiteral<'a>>,
    span: Span,
    specifiers: &'s [ExportSpecifier<'a>],
}

fn named_export<'s, 'a>(statement: &'s Statement<'a>) -> Option<NamedExport<'s, 'a>> {
    match statement {
        Statement::ExportDeclaration(export) => Some(NamedExport {
            declaration: Some(&export.declaration),
            export_kind: export.export_kind(),
            source: None,
            span: export.span,
            specifiers: &[],
        }),
        Statement::ExportNamedDeclaration(export) => Some(NamedExport {
            declaration: None,
            export_kind: export.export_kind,
            source: None,
            span: export.span,
            specifiers: &export.specifiers,
        }),
        Statement::ExportFromDeclaration(export) => Some(NamedExport {
            declaration: None,
            export_kind: export.export_kind,
            source: Some(&export.source),
            span: export.span,
            specifiers: &export.specifiers,
        }),
        _ => None,
    }
}

/// Whether exports supply neither constants nor authoring links. Local styles still need
/// extraction, but their importers do not need to wait for it.
fn opaque(program: &Program<'_>) -> bool {
    let types = |specifiers: &[ExportSpecifier<'_>]| {
        specifiers
            .iter()
            .all(|specifier| specifier.export_kind == ImportOrExportKind::Type)
    };

    program.body.iter().all(|statement| match statement {
        Statement::ExportDeclaration(export) => {
            export.export_kind() == ImportOrExportKind::Type
                || match &export.declaration {
                    Declaration::FunctionDeclaration(_) | Declaration::ClassDeclaration(_) => true,
                    Declaration::VariableDeclaration(declaration) => {
                        declaration.declarations.iter().all(|declaration| {
                            matches!(declaration.id, BindingPattern::BindingIdentifier(_))
                                && matches!(
                                    declaration.init,
                                    Some(
                                        Expression::ArrowFunctionExpression(_)
                                            | Expression::FunctionExpression(_)
                                            | Expression::ClassExpression(_)
                                    )
                                )
                        })
                    }
                    _ => false,
                }
        }
        Statement::ExportNamedDeclaration(export) => {
            export.export_kind == ImportOrExportKind::Type || types(&export.specifiers)
        }
        Statement::ExportFromDeclaration(export) => {
            export.export_kind == ImportOrExportKind::Type || types(&export.specifiers)
        }
        Statement::ExportAllDeclaration(export) => export.export_kind == ImportOrExportKind::Type,
        Statement::ExportDefaultDeclaration(export) => matches!(
            export.declaration,
            ExportDefaultDeclarationKind::FunctionDeclaration(_)
                | ExportDefaultDeclarationKind::ClassDeclaration(_)
                | ExportDefaultDeclarationKind::FunctionExpression(_)
                | ExportDefaultDeclarationKind::ArrowFunctionExpression(_)
                | ExportDefaultDeclarationKind::ClassExpression(_)
        ),
        _ => true,
    })
}

fn type_only(declaration: &oxc_ast::ast::ImportDeclaration<'_>) -> bool {
    declaration.specifiers.as_ref().is_some_and(|specifiers| {
        !specifiers.is_empty()
            && specifiers.iter().all(|specifier| {
                matches!(
                    specifier,
                    ImportDeclarationSpecifier::ImportSpecifier(specifier)
                        if specifier.import_kind == ImportOrExportKind::Type
                )
            })
    })
}

/// Adds the binding names a declaration pattern exports.
fn exported_bindings(pattern: &BindingPattern<'_>, names: &mut FxHashSet<String>) {
    match pattern {
        BindingPattern::BindingIdentifier(identifier) => {
            names.insert(identifier.name.to_string());
        }
        BindingPattern::ObjectPattern(object) => {
            for property in &object.properties {
                exported_bindings(&property.value, names);
            }

            if let Some(rest) = &object.rest {
                exported_bindings(&rest.argument, names);
            }
        }
        BindingPattern::ArrayPattern(array) => {
            for element in array.elements.iter().flatten() {
                exported_bindings(element, names);
            }

            if let Some(rest) = &array.rest {
                exported_bindings(&rest.argument, names);
            }
        }
        BindingPattern::AssignmentPattern(assignment) => {
            exported_bindings(&assignment.left, names);
        }
    }
}

/// The TypeScript `kind` of a named contribution, for explicit identity checks.
fn contribution_name(contribution: &Contribution) -> Option<(&'static str, &str)> {
    match &contribution.kind {
        ContributionKind::CustomMedia { name, .. } => Some(("custom-media", name)),
        ContributionKind::Descriptor { name, .. } => Some(("descriptor", name)),
        ContributionKind::Keyframes { name, .. } => Some(("keyframes", name)),
        ContributionKind::Namespace(definition) => Some(("namespace", &definition.name)),
        ContributionKind::Property { name, .. } => Some(("property", name)),
        _ => None,
    }
}

/// Matches `/\.[cm]?[jt]sx?$/` and removes it.
fn strip_script_extension(module_id: &str) -> &str {
    let Some(index) = module_id.rfind('.') else {
        return module_id;
    };
    let extension = &module_id[index + 1..];
    let extension = extension.strip_prefix(['c', 'm']).unwrap_or(extension);
    let extension = extension.strip_suffix('x').unwrap_or(extension);

    if extension == "js" || extension == "ts" {
        &module_id[..index]
    } else {
        module_id
    }
}

/// Validates packed CSS as `AtRules.transform` with `errorRecovery: false` does.
fn validate_css(filename: &str, css: &str) -> Result<()> {
    crate::compiler::internal::at_rules::validate(css, filename)
}

/// `JSON.stringify` of token values, which identifies explicit theme ids.
fn values_signature(definition: &Definition) -> String {
    let mut output = String::from("{");

    for (index, (path, value)) in definition.metadata.values.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }

        js::write_string(&mut output, path);
        output.push(':');
        crate::compiler::internal::packed_styles::write_data(
            &mut output,
            &variable_sets::value_data(value),
        );
    }

    output.push('}');
    output
}

impl<'p, 'a> Build<'p, 'a> {
    fn index(&self, module_id: &str) -> Option<usize> {
        self.indexes.get(module_id).copied()
    }

    fn source(&self, module_id: &str) -> Option<&'a str> {
        self.options.modules.get(module_id).map(|source| &**source)
    }

    /// Reuses the export classification without parsing unchanged dependencies.
    fn opaque(&self, module_id: &str) -> bool {
        if let Some(previous) = self.previous
            && previous.sources.get(module_id) == self.options.modules.get(module_id)
            && let Some(module) = previous.extracted.get(module_id)
        {
            return module.opaque;
        }

        self.parse(module_id)
            .is_some_and(|parsed| opaque(parsed.program))
    }

    fn allocator(&self, module_id: &str) -> Option<&'a Allocator> {
        let allocators: &'a [Allocator] = self.allocators;

        self.index(module_id)
            .and_then(|index| allocators.get(index))
    }

    fn parse(&self, module_id: &str) -> Option<&'p Parsed<'a>> {
        let parsed: &'p [OnceCell<Parsed<'a>>] = self.parsed;
        let index = self.index(module_id)?;
        let allocator = self.allocator(module_id)?;
        let source = self.source(module_id)?;

        parsed
            .get(index)
            .map(|cell| cell.get_or_init(|| syntax::parse(allocator, source, module_id)))
    }

    /// Converts a UTF-8 offset of a module into the UTF-16 offset JavaScript reports.
    fn utf16(&self, module_id: &str, offset: u32) -> u32 {
        let offsets: &'p [OnceCell<Utf16Index>] = self.offsets;

        match (self.index(module_id), self.source(module_id)) {
            (Some(index), Some(source)) => offsets.get(index).map_or(offset, |cell| {
                cell.get_or_init(|| Utf16Index::new(source)).utf16(offset)
            }),
            _ => offset,
        }
    }

    /// A `Source.ExtractError` for unsupported graph structure at an optional module span.
    fn fail(&self, module_id: &str, message: impl Into<String>, span: Option<Span>) -> Error {
        let (start, end) = span.map_or((0, 0), |span| {
            (
                self.utf16(module_id, span.start),
                self.utf16(module_id, span.end),
            )
        });

        Error::Extract(ExtractError::new(vec![Diagnostic {
            code: Code::UnsupportedSyntax,
            end,
            message: message.into(),
            source: Arc::from(module_id),
            start,
        }]))
    }

    fn validate_library_link(&mut self, link: &Link, owner: &str) -> Result<()> {
        let variable_owner = if owner.contains('/') {
            link.call.variable_owner.as_deref().unwrap_or(owner)
        } else {
            owner
        };

        for slot in link.call.variables.iter().flat_map(Record::values) {
            if let Some(previous) = self.variable_slots.get(&slot.name)
                && (previous.owner != variable_owner
                    || previous.binding != *link.binding
                    || previous.domain != slot.domain.as_str())
            {
                return Err(Error::Message(format!(
                    "Conflicting packed variable identity: {}; supply distinct declaration ids.",
                    slot.name
                )));
            }

            self.variable_slots.insert(
                slot.name.clone(),
                Slot {
                    binding: link.binding.to_string(),
                    domain: slot.domain.as_str(),
                    owner: variable_owner.to_owned(),
                },
            );
        }

        for member in link.members.iter().flat_map(Record::values) {
            self.validate_library_link(member, owner)?;
        }

        Ok(())
    }

    fn libraries(&mut self) -> Result<()> {
        let options = self.options;
        let mut identities = FxHashMap::default();
        let identifier = |value: &str| identifiers::read(value);
        let hooks = contract::Hooks {
            identifier: &identifier,
            validate: &validate_css,
        };

        for (id, text) in options
            .contracts
            .iter()
            .flat_map(|contracts| contracts.iter())
        {
            if options.modules.contains_key(id) {
                return Err(self.fail(
                    id,
                    "A module cannot supply both source and a library contract.",
                    None,
                ));
            }

            let result = (|| -> Result<Arc<Library>> {
                let library = match self
                    .previous
                    .and_then(|previous| previous.libraries.get(id))
                {
                    Some(library) => Arc::clone(library),
                    None => Arc::new(contract::read(text, &mut identities, id, &hooks)?),
                };

                for link in library.links.values() {
                    self.validate_library_link(link, id)?;
                }

                for (name, theme) in library.themes.iter() {
                    if let Some(existing) = self.themes.get(name) {
                        let write = |theme: &Arc<Definition>| {
                            let mut themes = Record::new();

                            themes.insert(Arc::clone(name), Arc::clone(theme));
                            contract::write(&contract::Write {
                                class_rules: &[],
                                configurations: &[],
                                links: &Record::new(),
                                literals: &Record::new(),
                                module_id: "",
                                stylesheets: &[],
                                themes: &themes,
                            })
                        };

                        if write(existing)? != write(theme)? {
                            return Err(Error::Message(format!(
                                "Conflicting library theme identity: {name}"
                            )));
                        }
                    }

                    self.themes.insert(Arc::clone(name), Arc::clone(theme));
                }

                Ok(library)
            })();

            match result {
                Ok(library) => {
                    self.libraries.insert(Arc::clone(id), library);
                }
                Err(error) => {
                    return Err(self.fail(
                        id,
                        format!("Invalid library contract: {}", error.text()),
                        None,
                    ));
                }
            }
        }

        Ok(())
    }

    /// Resolves an import through host resolutions, or relative to the closed graph.
    fn resolve(&self, module_id: &str, specifier: &str, span: Span) -> Result<Option<Arc<str>>> {
        let options = self.options;

        if let Some(imports) = &options.imports {
            let missing = || {
                self.fail(
                    module_id,
                    format!("Missing host resolution: {specifier}"),
                    Some(span),
                )
            };
            let target = imports
                .get(module_id)
                .ok_or_else(missing)?
                .get(specifier)
                .ok_or_else(missing)?;
            let Some(target) = target else {
                return Ok(None);
            };

            if !options.modules.contains_key(target) && !self.libraries.contains_key(target) {
                return Err(self.fail(
                    module_id,
                    format!("Missing host source module: {specifier}"),
                    Some(span),
                ));
            }

            return Ok(Some(Arc::clone(target)));
        }

        match relative::resolve(module_id, specifier, |id| options.modules.contains_key(id)) {
            Ok(target) => Ok(target.and_then(|target| {
                options
                    .modules
                    .get_key_value(target.as_str())
                    .map(|(id, _)| Arc::clone(id))
            })),
            Err(error) => Err(self.fail(module_id, error.text(), Some(span))),
        }
    }

    /// Copies a constant into the reading module's arena, with every span at the import.
    fn relocate(
        &self,
        module_id: &str,
        value: &'a Expression<'a>,
        span: Span,
    ) -> Option<&'a Expression<'a>> {
        let allocator = self.allocator(module_id)?;
        let mut copy = value.clone_in(allocator);

        Relocate(span).visit_expression(&mut copy);

        Some(allocator.alloc(copy))
    }

    /// Resolves an exported literal constant of a module, following re-exports.
    fn constant(
        &mut self,
        module_id: &Arc<str>,
        name: &str,
        active: &FxHashSet<(Arc<str>, String)>,
    ) -> Result<Option<&'a Expression<'a>>> {
        let key = (Arc::clone(module_id), name.to_owned());

        if let Some(value) = self.constants.get(&key) {
            return Ok(*value);
        }

        if let Some(library) = self.libraries.get(module_id) {
            let value = library.literals.get(name).and_then(|value| {
                self.allocators
                    .first()
                    .and_then(|allocator| literals::read(allocator, value))
            });
            self.constants.insert(key, value);

            return Ok(value);
        }

        if active.contains(&key)
            || !self.options.modules.contains_key(module_id)
            || self
                .extracted
                .get(module_id)
                .is_some_and(|module| module.opaque)
        {
            return Ok(None);
        }

        let mut next = active.clone();

        next.insert(key.clone());

        let Some(parsed) = self.parse(module_id) else {
            return Ok(None);
        };
        let program = parsed.program;
        let mut local = name.to_owned();
        let mut exported = false;
        let mut direct: Option<&'a ExportDefaultDeclarationKind<'a>> = None;
        let mut stars: Vec<Arc<str>> = Vec::new();

        for statement in &program.body {
            if let Statement::ExportDefaultDeclaration(declaration) = statement
                && name == "default"
            {
                direct = Some(&declaration.declaration);
                exported = true;
            }

            if let Statement::ExportAllDeclaration(declaration) = statement
                && declaration.export_kind != ImportOrExportKind::Type
                && declaration.exported.is_none()
                && name != "default"
                && let Some(target) =
                    self.resolve(module_id, &declaration.source.value, declaration.span)?
            {
                stars.push(target);
            }

            let Some(declaration) = named_export(statement) else {
                continue;
            };

            if declaration.export_kind == ImportOrExportKind::Type {
                continue;
            }

            if let Some(Declaration::VariableDeclaration(variables)) = declaration.declaration {
                exported |= variables.declarations.iter().any(|value| {
                    matches!(&value.id, BindingPattern::BindingIdentifier(identifier) if identifier.name == name)
                });
            }

            for specifier in declaration.specifiers {
                if specifier.export_kind == ImportOrExportKind::Type
                    || export_name(&specifier.exported) != name
                {
                    continue;
                }

                local = export_name(&specifier.local);

                if let Some(source) = declaration.source {
                    return match self.resolve(module_id, &source.value, declaration.span)? {
                        Some(target) => self.constant(&target, &local, &next),
                        None => Ok(None),
                    };
                }

                exported = true;
            }
        }

        if !exported {
            let mut candidates: Vec<&'a Expression<'a>> = Vec::new();

            for target in &stars {
                if let Some(value) = self.constant(target, name, &next)?
                    && !candidates
                        .iter()
                        .any(|candidate| std::ptr::eq(*candidate, value))
                {
                    candidates.push(value);
                }
            }

            let value = if candidates.len() == 1 {
                candidates.first().copied()
            } else {
                None
            };

            if value.is_some() || stars.is_empty() {
                self.constants.insert(key, value);
            }

            return Ok(value);
        }

        if let Some(declaration) = direct
            && matches!(
                declaration,
                ExportDefaultDeclarationKind::FunctionDeclaration(_)
                    | ExportDefaultDeclarationKind::ClassDeclaration(_)
                    | ExportDefaultDeclarationKind::FunctionExpression(_)
                    | ExportDefaultDeclarationKind::ArrowFunctionExpression(_)
                    | ExportDefaultDeclarationKind::ClassExpression(_)
            )
        {
            self.constants.insert(key, None);

            return Ok(None);
        }

        let mut imports: FxHashMap<String, &'a Expression<'a>> = FxHashMap::default();

        for statement in &program.body {
            let Statement::ImportDeclaration(declaration) = statement else {
                continue;
            };

            if declaration.import_kind == ImportOrExportKind::Type {
                continue;
            }

            let Some(target) =
                self.resolve(module_id, &declaration.source.value, declaration.span)?
            else {
                continue;
            };

            for specifier in declaration.specifiers.iter().flatten() {
                let imported = match specifier {
                    ImportDeclarationSpecifier::ImportNamespaceSpecifier(_) => continue,
                    ImportDeclarationSpecifier::ImportSpecifier(specifier) => {
                        if specifier.import_kind == ImportOrExportKind::Type {
                            continue;
                        }

                        export_name(&specifier.imported)
                    }
                    ImportDeclarationSpecifier::ImportDefaultSpecifier(_) => "default".to_owned(),
                };

                if let Some(value) = self.constant(&target, &imported, &next)?
                    && let Some(value) = self.relocate(module_id, value, specifier.span())
                {
                    imports.insert(specifier.name().to_string(), value);
                }
            }
        }

        let Some(allocator) = self.allocator(module_id) else {
            return Ok(None);
        };
        let data = statics::collect(allocator, program, &parsed.semantic, imports);
        let value = match direct {
            Some(declaration) => match declaration.as_expression() {
                Some(expression) => data
                    .normalize(
                        expression,
                        &FxHashSet::default(),
                        &FxHashSet::default(),
                        true,
                    )
                    .map(Some),
                None => return Ok(None),
            },
            None => data.exported(&local),
        };
        // Unsupported constants stay unresolved without caching, as a thrown evaluation does.
        let Ok(value) = value else {
            return Ok(None);
        };
        let value = value.filter(|value| literal(value, 0));

        self.constants.insert(key, value);

        Ok(value)
    }

    /// Resolves a stylesheet factory a module re-exports from `zyzz/web`.
    fn factory(
        &self,
        module_id: &str,
        name: &str,
        seen: &FxHashSet<String>,
    ) -> Result<Option<Arc<str>>> {
        if module_id == "zyzz/web" {
            return Ok(FACTORIES.contains(&name).then(|| Arc::from(name)));
        }

        let key = format!("{module_id}#{name}");

        if seen.contains(&key) || !self.options.modules.contains_key(module_id) {
            return Ok(None);
        }

        let mut next = seen.clone();

        next.insert(key);

        let Some(parsed) = self.parse(module_id) else {
            return Ok(None);
        };
        let program = parsed.program;
        let target = |specifier: &str, span: Span| -> Result<Option<Arc<str>>> {
            if specifier == "zyzz/web" {
                Ok(Some(Arc::from(specifier)))
            } else {
                self.resolve(module_id, specifier, span)
            }
        };

        for node in &program.body {
            let Some(node) = named_export(node) else {
                continue;
            };

            if node.export_kind == ImportOrExportKind::Type {
                continue;
            }

            let declares = match node.declaration {
                Some(Declaration::VariableDeclaration(variables)) => {
                    variables.declarations.iter().any(|item| {
                        matches!(&item.id, BindingPattern::BindingIdentifier(identifier) if identifier.name == name)
                    })
                }
                Some(Declaration::FunctionDeclaration(function)) => function
                    .id
                    .as_ref()
                    .is_some_and(|identifier| identifier.name == name),
                Some(Declaration::ClassDeclaration(class)) => class
                    .id
                    .as_ref()
                    .is_some_and(|identifier| identifier.name == name),
                _ => false,
            };

            if declares {
                return Ok(None);
            }

            for specifier in node.specifiers {
                if specifier.export_kind == ImportOrExportKind::Type
                    || export_name(&specifier.exported) != name
                {
                    continue;
                }

                let local = export_name(&specifier.local);

                if let Some(source) = node.source {
                    return match target(&source.value, node.span)? {
                        Some(id) => self.factory(&id, &local, &next),
                        None => Ok(None),
                    };
                }

                for declaration in &program.body {
                    let Statement::ImportDeclaration(declaration) = declaration else {
                        continue;
                    };

                    if declaration.import_kind == ImportOrExportKind::Type {
                        continue;
                    }

                    for imported in declaration.specifiers.iter().flatten() {
                        let ImportDeclarationSpecifier::ImportSpecifier(imported) = imported else {
                            continue;
                        };

                        if imported.import_kind == ImportOrExportKind::Type
                            || imported.local.name.as_str() != local
                        {
                            continue;
                        }

                        return match target(&declaration.source.value, declaration.span)? {
                            Some(id) => self.factory(&id, &export_name(&imported.imported), &next),
                            None => Ok(None),
                        };
                    }
                }

                return Ok(None);
            }
        }

        for node in &program.body {
            if let Statement::ExportAllDeclaration(node) = node
                && node.export_kind != ImportOrExportKind::Type
                && node.exported.is_none()
                && let Some(id) = target(&node.source.value, node.span)?
                && let Some(found) = self.factory(&id, name, &next)?
            {
                return Ok(Some(found));
            }
        }

        Ok(None)
    }

    /// Completes a link's packed style with the graph's default CSS output.
    fn output_link(&self, link: &Link) -> Link {
        let mut link = link.clone();

        if let Some(style) = &link.style {
            let mut packed = (**style).clone();

            packed.style = Arc::new(NamedStyle {
                css_output: Some(
                    packed
                        .style
                        .css_output
                        .or(self.options.css_output)
                        .unwrap_or(CssOutput::Atomic),
                ),
                ..(*packed.style).clone()
            });
            link.style = Some(Arc::new(packed));
        }

        if let Some(members) = &link.members {
            let mut linked = Record::new();

            for (name, member) in members.iter() {
                linked.insert(Arc::clone(name), self.output_link(member));
            }

            link.members = Some(linked);
        }

        link
    }

    /// Extracts a module with the links, constants, and factories its imports supply.
    fn link(&mut self, module_id: &Arc<str>) -> Result<Linked<'a>> {
        let options = self.options;
        let source = self.source(module_id).unwrap_or_default();

        // Validate identity and syntax through the public source boundary before linking.
        source::extract(
            &Allocator::default(),
            &source::Options {
                compiler: None,
                context: None,
                module_id,
                parsed: None,
                source: "",
                target: Target::Web,
            },
        )?;

        let Some(parsed) = self.parse(module_id) else {
            return Err(Error::Message(format!(
                "Missing source module: {module_id}"
            )));
        };

        if !parsed.errors.is_empty() {
            source::extract(
                &Allocator::default(),
                &source::Options {
                    compiler: None,
                    context: None,
                    module_id,
                    parsed: None,
                    source,
                    target: Target::Web,
                },
            )?;
        }

        if options.imports.is_none() {
            let mut imports = Imports { dynamic: None };

            imports.visit_program(parsed.program);

            if let Some(span) = imports.dynamic {
                return Err(self.fail(
                    module_id,
                    "Source graph dependencies require static imports.",
                    Some(span),
                ));
            }
        }

        let mut values: Record<&'a Expression<'a>> = Record::new();
        let mut links: Record<Link> = Record::new();
        let mut forwarded: Record<Link> = Record::new();
        let mut forwarded_literals = Record::new();
        let mut explicit: FxHashSet<String> = FxHashSet::default();
        let mut stars: Vec<Input> = Vec::new();
        let mut imports: IndexSet<Arc<str>, FxBuildHasher> = IndexSet::default();
        let empty = Record::new();

        for node in &parsed.program.body {
            if let Some(declaration) = named_export(node)
                && declaration.source.is_none()
                && declaration.export_kind != ImportOrExportKind::Type
            {
                for specifier in declaration.specifiers {
                    if specifier.export_kind != ImportOrExportKind::Type {
                        explicit.insert(export_name(&specifier.exported));
                    }
                }

                match declaration.declaration {
                    Some(Declaration::VariableDeclaration(variables)) => {
                        for variable in &variables.declarations {
                            exported_bindings(&variable.id, &mut explicit);
                        }
                    }
                    Some(Declaration::FunctionDeclaration(function)) => {
                        if let Some(identifier) = &function.id {
                            explicit.insert(identifier.name.to_string());
                        }
                    }
                    Some(Declaration::ClassDeclaration(class)) => {
                        if let Some(identifier) = &class.id {
                            explicit.insert(identifier.name.to_string());
                        }
                    }
                    _ => {}
                }
            }

            let (specifier, span) = match node {
                Statement::ImportDeclaration(declaration) => {
                    if declaration.import_kind == ImportOrExportKind::Type || type_only(declaration)
                    {
                        continue;
                    }

                    (&declaration.source.value, declaration.span)
                }
                Statement::ExportFromDeclaration(declaration) => {
                    let source = &declaration.source;

                    if declaration.export_kind == ImportOrExportKind::Type
                        || (!declaration.specifiers.is_empty()
                            && declaration
                                .specifiers
                                .iter()
                                .all(|specifier| specifier.export_kind == ImportOrExportKind::Type))
                    {
                        continue;
                    }

                    (&source.value, declaration.span)
                }
                Statement::ExportAllDeclaration(declaration) => {
                    if declaration.export_kind == ImportOrExportKind::Type {
                        continue;
                    }

                    (&declaration.source.value, declaration.span)
                }
                _ => continue,
            };
            let Some(target) = self.resolve(module_id, specifier, span)? else {
                continue;
            };

            imports.insert(Arc::clone(&target));

            let input = match self.libraries.get(&target) {
                Some(library) => Input::Library(Arc::clone(library)),
                None if self.opaque(&target) => Input::Runtime,
                None => Input::Module(self.visit(&target)?),
            };
            let contracts = match &input {
                Input::Library(library) => &library.links,
                Input::Module(module) => &module.theme_exports,
                Input::Runtime => &empty,
            };
            let namespace = |name: &str| -> Option<Link> {
                let first = contracts.values().next()?;
                let mut key = String::from("[");

                js::write_string(&mut key, module_id);
                key.push(',');
                js::write_string(&mut key, name);
                key.push(']');

                Some(Link {
                    binding: Arc::from(format!("z-style-{}-namespace", identity::hash(&key))),
                    call: themes::Call {
                        end: u32::MAX,
                        name: Arc::from(""),
                        start: u32::MAX,
                        token_type: Arc::from("{}"),
                        ..themes::Call::default()
                    },
                    definition: Arc::clone(&first.definition),
                    kind: LinkKind::StyleReference,
                    members: Some(contracts.clone()),
                    style: None,
                })
            };
            let references_only = || {
                contracts
                    .values()
                    .all(|link| link.kind == LinkKind::StyleReference)
            };

            match node {
                Statement::ImportDeclaration(declaration) => {
                    for specifier in declaration.specifiers.iter().flatten() {
                        let name = match specifier {
                            ImportDeclarationSpecifier::ImportNamespaceSpecifier(
                                namespace_import,
                            ) => {
                                if !references_only() {
                                    return Err(self.fail(
                                        module_id,
                                        "Import theme contracts by name; namespace imports are not supported.",
                                        Some(namespace_import.span),
                                    ));
                                }

                                if let Some(link) = namespace(&namespace_import.local.name) {
                                    links.insert(namespace_import.local.name.as_str(), link);
                                }

                                continue;
                            }
                            ImportDeclarationSpecifier::ImportSpecifier(specifier) => {
                                if specifier.import_kind == ImportOrExportKind::Type {
                                    continue;
                                }

                                export_name(&specifier.imported)
                            }
                            ImportDeclarationSpecifier::ImportDefaultSpecifier(_) => {
                                "default".to_owned()
                            }
                        };
                        let local = specifier.name();

                        if let Some(link) = contracts.get(&name) {
                            links.insert(local.as_str(), link.clone());
                        } else if let Some(value) =
                            self.constant(&target, &name, &FxHashSet::default())?
                            && let Some(value) = self.relocate(module_id, value, specifier.span())
                        {
                            values.insert(local.as_str(), value);
                        }
                    }
                }
                Statement::ExportAllDeclaration(declaration) => {
                    if let Some(exported) = &declaration.exported {
                        if !references_only() {
                            return Err(self.fail(
                                module_id,
                                "Namespace theme re-exports are not supported.",
                                Some(declaration.span),
                            ));
                        }

                        let name = export_name(exported);

                        if let Some(link) = namespace(&name) {
                            forwarded.insert(name.as_str(), link);
                        }

                        explicit.insert(name);
                    } else {
                        stars.push(input.clone());
                    }
                }
                Statement::ExportFromDeclaration(declaration) => {
                    for specifier in &declaration.specifiers {
                        if specifier.export_kind == ImportOrExportKind::Type {
                            continue;
                        }

                        let name = export_name(&specifier.local);
                        let exported = export_name(&specifier.exported);

                        if let Some(link) = contracts.get(&name) {
                            forwarded.insert(exported.as_str(), link.clone());
                        }

                        let literal = match &input {
                            Input::Library(library) => library.literals.get(&name),
                            Input::Module(module) => module.literals.get(&name),
                            Input::Runtime => None,
                        };

                        if let Some(value) = literal {
                            forwarded_literals.insert(exported.as_str(), Arc::clone(value));
                        }

                        explicit.insert(exported);
                    }
                }
                _ => {}
            }
        }

        let mut factories: Record<Arc<str>> = Record::new();

        for node in &parsed.program.body {
            let Statement::ImportDeclaration(declaration) = node else {
                continue;
            };

            if declaration.import_kind == ImportOrExportKind::Type
                || declaration.specifiers.iter().flatten().all(|specifier| {
                    matches!(
                        specifier,
                        ImportDeclarationSpecifier::ImportSpecifier(specifier)
                            if specifier.import_kind == ImportOrExportKind::Type
                    )
                })
                || matches!(
                    declaration.source.value.as_str(),
                    "zyzz" | "zyzz/base-ui/react" | "zyzz/web"
                )
            {
                continue;
            }

            let Some(target) =
                self.resolve(module_id, &declaration.source.value, declaration.span)?
            else {
                continue;
            };

            for specifier in declaration.specifiers.iter().flatten() {
                let ImportDeclarationSpecifier::ImportSpecifier(specifier) = specifier else {
                    continue;
                };

                if specifier.import_kind == ImportOrExportKind::Type {
                    continue;
                }

                if let Some(found) = self.factory(
                    &target,
                    &export_name(&specifier.imported),
                    &FxHashSet::default(),
                )? {
                    factories.insert(specifier.local.name.as_str(), found);
                }
            }
        }

        let mut published_literals = if !options.lean && options.entry.is_none() {
            self.allocator(module_id)
                .map(|allocator| literals::exports(allocator, parsed, &values))
                .unwrap_or_default()
        } else {
            Record::new()
        };

        for (name, value) in forwarded_literals.iter() {
            published_literals.insert(Arc::clone(name), Arc::clone(value));
        }

        let context = themes::Context {
            constants: Some(values),
            factories: Some(factories),
            links,
            ..themes::Context::default()
        };
        let Some(allocator) = self.allocator(module_id) else {
            return Err(Error::Message(format!(
                "Missing source module: {module_id}"
            )));
        };
        let mut extracted = source::extract(
            allocator,
            &source::Options {
                compiler: options.compiler,
                context: Some(&context),
                module_id,
                parsed: Some(parsed),
                source,
                target: if options.native.is_some() {
                    Target::Native
                } else {
                    Target::Web
                },
            },
        )?;
        let mut exports = forwarded;

        for (name, link) in extracted.theme_exports.iter().flat_map(Record::iter) {
            exports.insert(Arc::clone(name), self.output_link(link));
            explicit.insert(name.to_string());
        }

        for input in &stars {
            let contracts = match input {
                Input::Library(library) => &library.links,
                Input::Module(module) => &module.theme_exports,
                Input::Runtime => &empty,
            };

            for (name, link) in contracts.iter() {
                if &**name == "default" || explicit.contains(&**name) {
                    continue;
                }

                if let Some(previous) = exports.get(name)
                    && (previous.binding != link.binding || previous.kind != link.kind)
                {
                    return Err(self.fail(
                        module_id,
                        format!("Ambiguous theme re-export: {name}"),
                        None,
                    ));
                }

                exports.insert(Arc::clone(name), link.clone());
            }
        }

        extracted.theme_exports = Some(exports);

        let mut star_literals = Record::new();
        let mut ambiguous = FxHashSet::default();

        for input in &stars {
            let source = match input {
                Input::Library(library) => &library.literals,
                Input::Module(module) => &module.literals,
                Input::Runtime => continue,
            };

            for (name, value) in source.iter() {
                if &**name == "default" || explicit.contains(&**name) {
                    continue;
                }
                if star_literals
                    .get(name)
                    .is_some_and(|previous| !Arc::ptr_eq(previous, value))
                {
                    ambiguous.insert(Arc::clone(name));
                }

                star_literals.insert(Arc::clone(name), Arc::clone(value));
            }
        }

        for (name, value) in star_literals.iter() {
            if !ambiguous.contains(name) {
                published_literals.insert(Arc::clone(name), Arc::clone(value));
            }
        }

        if options.lean || options.entry.is_some() {
            published_literals = Record::new();
        }

        Ok(Linked {
            extracted,
            imports: imports.into_iter().collect(),
            literals: published_literals,
            opaque: opaque(parsed.program),
        })
    }

    /// Extracts a module once per compilation, reusing an earlier compilation's result when the
    /// module and every input it read are unchanged.
    fn visit(&mut self, module_id: &Arc<str>) -> Result<Arc<Module>> {
        if let Some(module) = self.extracted.get(module_id) {
            return Ok(Arc::clone(module));
        }

        if self.visiting.contains(module_id) {
            return Err(self.fail(
                module_id,
                "Circular source dependencies are not supported yet.",
                None,
            ));
        }

        self.visiting.insert(Arc::clone(module_id));

        let options = self.options;
        let snapshot = self.previous.and_then(|previous| {
            previous.retained.get(module_id).cloned().or_else(|| {
                let source = previous.sources.get(module_id)?;
                let dependencies = previous.result.dependencies.get(module_id)?;

                Some(Extraction {
                    dependencies: Arc::clone(dependencies),
                    extracted: Arc::clone(previous.extracted.get(module_id)?),
                    inputs: dependencies
                        .iter()
                        .filter_map(|target| {
                            let input = if let Some(library) = previous.libraries.get(target) {
                                Input::Library(Arc::clone(library))
                            } else {
                                let module = previous.extracted.get(target)?;

                                if module.opaque {
                                    Input::Runtime
                                } else {
                                    Input::Module(Arc::clone(module))
                                }
                            };

                            Some((Arc::clone(target), input))
                        })
                        .collect(),
                    resolution: previous.resolutions.get(module_id)?.clone(),
                    source: Arc::clone(source),
                })
            })
        });

        if let Some(snapshot) = snapshot
            && options.modules.get(module_id) == Some(&snapshot.source)
            && self.resolutions.get(module_id) == Some(&snapshot.resolution)
        {
            let mut reusable = true;

            for target in snapshot.dependencies.iter() {
                let input = snapshot
                    .inputs
                    .iter()
                    .find(|(id, _)| id == target)
                    .map(|(_, input)| input);
                let same = if let Some(library) = self.libraries.get(target) {
                    matches!(input, Some(Input::Library(input)) if Arc::ptr_eq(input, library))
                } else if options.modules.contains_key(target) {
                    if self.opaque(target) {
                        matches!(input, Some(Input::Runtime))
                    } else if matches!(input, Some(Input::Runtime)) {
                        // Re-link before following a new extraction edge. The old runtime
                        // dependency may now supply a style, or may have introduced a cycle.
                        false
                    } else {
                        let module = self.visit(target)?;

                        matches!(input, Some(Input::Module(input)) if Arc::ptr_eq(input, &module))
                    }
                } else {
                    false
                };

                if !same {
                    reusable = false;
                    break;
                }
            }

            if reusable {
                return self.retain(module_id, snapshot.extracted, snapshot.dependencies);
            }
        }

        let linked = self.link(module_id)?;
        let module = Arc::new(Module {
            literals: linked.literals,
            opaque: linked.opaque,
            ..Module::detach(&linked.extracted)
        });
        // A module re-extracted only because a dependency changed usually extracts as before.
        // Keeping the previous identity then lets the modules that read it reuse their own
        // extractions, and its unchanged source keeps transform reuse sound.
        let module = match self.previous.and_then(|previous| {
            previous
                .extracted
                .get(module_id)
                .filter(|_| previous.sources.get(module_id) == options.modules.get(module_id))
        }) {
            Some(previous) if **previous == *module => Arc::clone(previous),
            _ => module,
        };

        // Only extracted modules contribute names, as the TypeScript graph walks only those.
        if options.native.is_some()
            && let Some(parsed) = self.parse(module_id)
        {
            let names = native::identifiers(parsed, "__zyzz")
                .into_iter()
                .map(Arc::from)
                .collect();

            self.identifiers.insert(Arc::clone(module_id), names);
        }

        self.fresh.insert(Arc::clone(module_id), linked.extracted);
        self.retain(module_id, module, linked.imports)
    }

    fn retain(
        &mut self,
        module_id: &Arc<str>,
        module: Arc<Module>,
        imports: Arc<[Arc<str>]>,
    ) -> Result<Arc<Module>> {
        let options = self.options;
        let owner = strip_script_extension(module_id);

        for call in &module.variable_calls {
            for slot in call.slots.values() {
                if let Some(previous) = self.variable_slots.get(&slot.name)
                    && (previous.owner != owner || previous.domain != slot.domain.as_str())
                {
                    return Err(self.fail(
                        module_id,
                        format!(
                            "Conflicting variable identity: {}; supply distinct declaration ids.",
                            slot.name
                        ),
                        Some(Span::new(call.start, call.end)),
                    ));
                }

                self.variable_slots.insert(
                    slot.name.clone(),
                    Slot {
                        binding: format!("source:{}", call.start),
                        domain: slot.domain.as_str(),
                        owner: owner.to_owned(),
                    },
                );
            }
        }

        let source = options.modules.get(module_id).cloned().unwrap_or_default();

        self.extracted
            .insert(Arc::clone(module_id), Arc::clone(&module));
        self.dependencies
            .insert(Arc::clone(module_id), Arc::clone(&imports));
        let inputs = imports
            .iter()
            .filter_map(|target| {
                let input = match self.libraries.get(target) {
                    Some(library) => Input::Library(Arc::clone(library)),
                    None if self.opaque(target) => Input::Runtime,
                    None => Input::Module(Arc::clone(self.extracted.get(target)?)),
                };

                Some((Arc::clone(target), input))
            })
            .collect();

        self.retained.insert(
            Arc::clone(module_id),
            Extraction {
                dependencies: imports,
                extracted: Arc::clone(&module),
                inputs,
                resolution: self.resolutions.get(module_id).cloned().unwrap_or_default(),
                source: Arc::clone(&source),
            },
        );

        for call in &module.theme_calls {
            let mut names: Vec<&Arc<str>> = vec![&call.name];

            for name in call.members.iter().flat_map(Record::values) {
                if !names.contains(&name) {
                    names.push(name);
                }
            }

            for name in names {
                self.owners.insert(
                    Arc::clone(name),
                    Owner {
                        call: themes::Call {
                            name: Arc::clone(name),
                            ..call.clone()
                        },
                        module_id: Arc::clone(module_id),
                        source: Arc::clone(&source),
                    },
                );
            }
        }

        for (name, theme) in module.vars.iter() {
            self.themes.insert(Arc::clone(name), Arc::clone(theme));
        }

        self.visiting.remove(module_id);

        Ok(module)
    }
}

/// Publishes a link for a native contract, whose packed styles carry no compiled classes.
fn packed_link(link: &Link) -> Link {
    let mut link = link.clone();

    if let Some(style) = &link.style {
        let mut packed = (**style).clone();

        packed.class_name = Some(packed.class_name.unwrap_or_else(|| Arc::from("")));
        link.style = Some(Arc::new(packed));
    }

    if let Some(members) = &link.members {
        let mut packed = Record::new();

        for (name, member) in members.iter() {
            packed.insert(Arc::clone(name), packed_link(member));
        }

        link.members = Some(packed);
    }

    link
}

/// Native variable profiles a graph assigns to modules, and the names they reserve.
struct Profiles {
    /// Identifiers of the extracted modules and every generated profile name.
    reserved: FxHashSet<String>,
    /// Profiles by module identity, created when a module defines or reads one.
    shared: FxHashMap<Arc<str>, native_vars::Shared>,
}

impl Profiles {
    /// Names the serialized profile `value` that `owner` exports, once per owner and value.
    fn define(&mut self, owner: &Arc<str>, value: String) -> String {
        let definitions = &mut self
            .shared
            .entry(Arc::clone(owner))
            .or_default()
            .definitions;

        if let Some(name) = definitions.get(&value) {
            return name.clone();
        }

        let mut key = String::with_capacity(owner.len() + value.len());

        key.push_str(owner);
        key.push_str(&value);

        // Hashing the owner keeps names independent of which modules share the graph.
        let mut name = format!("__zyzzProfile{}", identity::hash(&key));

        while self.reserved.contains(&name) {
            name.push('_');
        }

        self.reserved.insert(name.clone());
        definitions.insert(value, name.clone());
        name
    }
}

/// Replaces a trailing `.ts`, `.tsx`, `.cts`, or `.mts` extension with its JavaScript form, as
/// `/\.([cm]?)tsx?$/` with `.$1js` does.
fn script_output(path: &str) -> String {
    for (extension, output) in [
        (".ctsx", ".cjs"),
        (".mtsx", ".mjs"),
        (".cts", ".cjs"),
        (".mts", ".mjs"),
        (".tsx", ".js"),
        (".ts", ".js"),
    ] {
        if let Some(stem) = path.strip_suffix(extension) {
            return format!("{stem}{output}");
        }
    }

    path.to_owned()
}

/// The relative specifier from a module to the module that owns a profile.
fn relative_specifier(module_id: &str, owner: &str) -> String {
    let mut from: Vec<&str> = module_id.split('/').collect();

    from.pop();

    let to: Vec<&str> = owner.split('/').collect();
    let common = from
        .iter()
        .zip(&to)
        .take_while(|(left, right)| left == right)
        .count();
    let up = from.len() - common;
    let mut specifier = if up == 0 {
        "./".to_owned()
    } else {
        "../".repeat(up)
    };

    specifier.push_str(&to.get(common..).unwrap_or_default().join("/"));
    script_output(&specifier)
}

/// Publishes a link with the class names its style compiled to in this graph.
fn published_style(link: &Link, classes: &FxHashMap<Arc<str>, Arc<str>>) -> Link {
    let mut link = link.clone();

    if let Some(style) = &link.style {
        let mut packed = (**style).clone();

        if let Some(class_name) = classes.get(&link.binding) {
            packed.class_name = Some(Arc::clone(class_name));
        }

        link.style = Some(Arc::new(packed));
    }

    if let Some(members) = &link.members {
        let mut published = Record::new();

        for (name, member) in members.iter() {
            published.insert(Arc::clone(name), published_style(member, classes));
        }

        link.members = Some(published);
    }

    link
}

/// Records the class names packed library styles publish, by binding.
fn published(link: &Link, classes: &mut FxHashMap<Arc<str>, Arc<str>>) {
    if let Some(class_name) = link
        .style
        .as_ref()
        .and_then(|style| style.class_name.as_ref())
    {
        classes.insert(Arc::clone(&link.binding), Arc::clone(class_name));
    }

    for member in link.members.iter().flat_map(Record::values) {
        published(member, classes);
    }
}

/// The layer constraint that orders the reset before every authored layer.
fn reset_layers(names: &[Arc<str>]) -> Vec<Vec<Arc<str>>> {
    if names.is_empty() {
        return vec![vec![Arc::from("reset")]];
    }

    names
        .iter()
        .map(|name| vec![Arc::from("reset"), Arc::clone(name)])
        .collect()
}

/// Unique layer names of sections, except `reset`, in first-use order.
fn layer_names(sections: &[Section]) -> Vec<Arc<str>> {
    let mut names: IndexSet<Arc<str>, FxBuildHasher> = IndexSet::default();

    for name in sections
        .iter()
        .flat_map(|section| section.layers.iter().flatten())
    {
        if &**name != "reset" {
            names.insert(Arc::clone(name));
        }
    }

    names.into_iter().collect()
}

fn json_or_null(output: &mut String, value: Option<&str>) {
    match value {
        Some(value) => js::write_string(output, value),
        None => output.push_str("null"),
    }
}

/// Collects the identity classes that the selectors of a graph's styles and contributions
/// reference, decoding CSS escapes so each class compares by its name.
fn references<'m>(modules: impl Iterator<Item = &'m Module>) -> FxHashSet<Arc<str>> {
    fn scan(selector: &str, output: &mut FxHashSet<Arc<str>>) {
        for (index, _) in selector.match_indices(".z-style-") {
            let mut name = String::from("z-style-");
            let mut characters = selector
                .get(index + ".z-style-".len()..)
                .unwrap_or_default()
                .chars()
                .peekable();

            while let Some(character) = characters.next() {
                if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                    name.push(character);
                    continue;
                }

                if character != '\\' {
                    break;
                }

                let mut code = 0_u32;
                let mut digits = 0;

                while digits < 6
                    && let Some(digit) = characters.peek().and_then(|next| next.to_digit(16))
                {
                    code = code * 16 + digit;
                    digits += 1;
                    characters.next();
                }

                if digits == 0 {
                    match characters.next() {
                        Some(escaped) => name.push(escaped),
                        None => break,
                    }

                    continue;
                }

                // One whitespace character terminates a hexadecimal escape.
                characters.next_if(|next| js::is_whitespace(*next));
                name.push(char::from_u32(code).unwrap_or('\u{fffd}'));
            }

            output.insert(Arc::from(name));
        }
    }

    fn style(value: &NamedStyle, output: &mut FxHashSet<Arc<str>>) {
        for rule in value.rules.iter().flatten() {
            if let Some(condition) = &rule.condition {
                scan(condition, output);
            }

            style(&rule.style, output);
        }
    }

    let mut output = FxHashSet::default();

    for module in modules {
        for value in &module.styles.styles {
            style(value, &mut output);
        }

        for contribution in &module.contributions {
            for group in &contribution.within {
                scan(group, &mut output);
            }

            if let ContributionKind::Rule {
                selector,
                style: value,
            } = &contribution.kind
            {
                scan(selector, &mut output);
                style(value, &mut output);
            }
        }
    }

    output
}

/// Registers the explicit style identities a packed link publishes.
fn styles(link: &Link, register: &mut dyn FnMut(String, String) -> Result<()>) -> Result<()> {
    if let Some(style) = &link.style {
        for name in style.class_name.as_deref().unwrap_or_default().split(' ') {
            if name.starts_with("z-style-id-") {
                register(name.to_owned(), identity::style(&style.style, None))?;
            }
        }
    }

    for member in link.members.iter().flat_map(Record::values) {
        styles(member, register)?;
    }

    Ok(())
}

impl Build<'_, '_> {
    fn reachable(
        &self,
        sections: &Map<Vec<Section>>,
        id: &Arc<str>,
        visited: &mut FxHashSet<Arc<str>>,
    ) -> Vec<Section> {
        if !visited.insert(Arc::clone(id)) {
            return Vec::new();
        }

        let mut output = Vec::new();

        for dependency in self
            .dependencies
            .get(id)
            .iter()
            .flat_map(|dependencies| dependencies.iter())
        {
            output.extend(self.reachable(sections, dependency, visited));
        }

        output.extend(sections.get(id).cloned().unwrap_or_default());
        output
    }

    fn dependency_path(&self, from: &Arc<str>, to: &Arc<str>) -> Result<Vec<Arc<str>>> {
        let mut queue: std::collections::VecDeque<(Arc<str>, Vec<Arc<str>>)> =
            std::collections::VecDeque::from([(Arc::clone(from), Vec::new())]);
        let mut seen: FxHashSet<Arc<str>> = FxHashSet::default();

        while let Some((id, path)) = queue.pop_front() {
            if id == *to {
                return Ok(path);
            }

            if !seen.insert(Arc::clone(&id)) {
                continue;
            }

            for (specifier, target) in self
                .options
                .imports
                .iter()
                .filter_map(|imports| imports.get(&id))
                .flat_map(|imports| imports.iter())
            {
                if let Some(target) = target {
                    let mut next = path.clone();

                    next.push(Arc::clone(specifier));
                    queue.push_back((Arc::clone(target), next));
                }
            }
        }

        Err(self.fail(
            from,
            "Repacked stylesheet ownership requires a resolved dependency path.",
            None,
        ))
    }

    /// Emits token resources once for every deferred module's references. A previous emission
    /// for the same themes and schemes is reused while the references are unchanged.
    fn scoped(
        modules: &Map<Arc<transform::Output>>,
        scopes: &[(Arc<str>, Scope)],
        schemes: bool,
        previous: Option<&Cache>,
    ) -> Result<Arc<Scoped>> {
        let mut seen: FxHashSet<usize> = FxHashSet::default();
        let mut references: Vec<Arc<Reference>> = Vec::new();

        for reference in modules
            .values()
            .filter_map(|output| output.references.as_deref())
            .flatten()
        {
            if seen.insert(Arc::as_ptr(reference).addr()) {
                references.push(Arc::clone(reference));
            }
        }

        // A canonical replay order keeps the emitted resources when an edit only reorders a
        // module's references.
        references.sort_by(|left, right| {
            left.contract
                .identity
                .cmp(&right.contract.identity)
                .then_with(|| left.path.cmp(&right.path))
        });

        if let Some(cached) = previous.and_then(|previous| previous.scoped.as_ref())
            && cached.references.len() == references.len()
            && cached
                .references
                .iter()
                .zip(&references)
                .all(|(left, right)| Arc::ptr_eq(left, right) || left == right)
        {
            return Ok(Arc::clone(cached));
        }

        let mut collector = Themes::new();

        for reference in &references {
            collector.serialize(reference);
        }

        let emitted = collector
            .emit(scopes, schemes, Some(Shared::All))
            .map_err(|message| {
                Error::Css(vec![css::Diagnostic::new(
                    css::Code::InvalidTheme,
                    message,
                    vec![Arc::from("vars")],
                )])
            })?;

        Ok(Arc::new(Scoped {
            references: references.into(),
            resources: emitted.resources.into(),
        }))
    }

    /// Wraps a rendering failure as an extraction error of the conflicting owner.
    fn render_error(&self, error: &Error, ids: &[Arc<str>]) -> Error {
        let source = match error {
            Error::Conflict { source, .. } => Arc::clone(source),
            _ => ids.first().cloned().unwrap_or_default(),
        };

        self.fail(&source, error.text(), None)
    }

    /// Renders a shared stylesheet, which parses and serializes every section. A section list the
    /// previous compilation rendered renders as it did then.
    fn render_shared(&mut self, sections: &[Section], ids: &[Arc<str>]) -> Result<Rendered> {
        let cached = self
            .previous
            .iter()
            .flat_map(|previous| previous.renders.iter())
            .find(|render| render.0 == sections)
            .cloned();
        let render = match cached {
            Some(render) => render,
            None => Arc::new((
                sections.to_vec(),
                stylesheets::render(sections).map_err(|error| self.render_error(&error, ids))?,
            )),
        };
        let rendered = render.1.clone();

        self.renders.push(render);
        Ok(rendered)
    }

    fn register_rules<'r>(
        &mut self,
        rules: impl Iterator<Item = (&'r str, &'r str)>,
        module_id: &Arc<str>,
    ) -> Result<()> {
        for (name, body) in rules {
            match self.emitted_rules.get_mut(name) {
                // Every module repeats the graph's scope rules, so equal rules only change owner.
                Some((previous, owner)) if previous == body => *owner = Arc::clone(module_id),
                Some((_, owner)) => {
                    let generated = match name.strip_prefix("@scope:") {
                        Some(rest) => {
                            format!("scope {}", rest.split(':').next().unwrap_or_default())
                        }
                        None => format!("class {name}"),
                    };

                    return Err(Error::Css(vec![css::Diagnostic::new(
                        css::Code::IdentityCollision,
                        format!(
                            "Generated {generated} conflicts with module {owner}. Supply distinct config or style ids."
                        ),
                        vec![Arc::clone(module_id)],
                    )]));
                }
                None => {
                    self.emitted_rules
                        .insert(name.to_owned(), (body.to_owned(), Arc::clone(module_id)));
                }
            }
        }

        Ok(())
    }

    /// Rejects explicit identities that name different definitions across the graph.
    fn portable_identities(&self) -> Result<()> {
        let mut identities: FxHashMap<String, String> = FxHashMap::default();

        for (module_id, library) in &self.libraries {
            let mut register = |name: String, signature: String| -> Result<()> {
                if let Some(previous) = identities.get(&name)
                    && *previous != signature
                {
                    return Err(self.fail(
                        module_id,
                        "The same explicit identity is used for different definitions.",
                        None,
                    ));
                }

                identities.insert(name, signature);

                Ok(())
            };

            for (name, theme) in library.themes.iter() {
                if theme
                    .metadata
                    .contract
                    .identity
                    .as_deref()
                    .is_some_and(|identity| identity.starts_with("id-"))
                {
                    register(format!("theme:{name}"), values_signature(theme))?;
                }
            }

            for link in library.links.values() {
                styles(link, &mut register)?;
            }
        }

        for (module_id, module) in &self.extracted {
            let mut register = |name: String, signature: String| -> Result<()> {
                if let Some(previous) = identities.get(&name)
                    && *previous != signature
                {
                    return Err(self.fail(
                        module_id,
                        "The same explicit identity is used for different definitions.",
                        None,
                    ));
                }

                identities.insert(name, signature);

                Ok(())
            };

            for (name, theme) in module.vars.iter() {
                if theme
                    .metadata
                    .contract
                    .identity
                    .as_deref()
                    .is_some_and(|identity| identity.starts_with("id-"))
                {
                    register(format!("theme:{name}"), values_signature(theme))?;
                }
            }

            for contribution in &module.contributions {
                if let Some((kind, name)) = contribution_name(contribution) {
                    let css = css::compile(
                        &css::Options {
                            contributions: std::slice::from_ref(contribution),
                            ..css::Options::default()
                        },
                        None,
                    )?
                    .css;

                    register(format!("{kind}:{name}"), css)?;
                }
            }

            for call in &module.calls {
                let Some(portable) = call
                    .portable
                    .as_deref()
                    .filter(|portable| portable.starts_with("z-style-id-"))
                else {
                    continue;
                };
                let Some(style) = module
                    .styles
                    .styles
                    .iter()
                    .find(|style| style.name == call.name)
                else {
                    continue;
                };
                let signature = identity::style(style, None);

                if identities
                    .get(portable)
                    .is_some_and(|previous| *previous != signature)
                {
                    return Err(self.fail(
                        module_id,
                        "The same explicit style id is used for different declarations.",
                        None,
                    ));
                }

                identities.insert(portable.to_owned(), signature);
            }
        }

        Ok(())
    }

    /// Catalogs of configurations whose module uses root controls or the script, exported or
    /// not, so initialization restores the selections they persist.
    fn configurations(module: &Module, themes: &Record<Arc<Definition>>) -> Vec<Configuration> {
        module
            .theme_calls
            .iter()
            .filter(|call| {
                call.appearance
                    && call.options.is_some()
                    && (module.theme_appearances.contains(&call.name)
                        || module.theme_scripts.contains(&call.name))
            })
            .map(|call| {
                let options = call.options.as_ref();
                let names = match options.and_then(|options| options.get("themes")) {
                    Some(Data::Object(object)) => object.keys().cloned().collect(),
                    Some(Data::Array(items)) => (0..items.len())
                        .map(|index| Arc::from(index.to_string()))
                        .collect(),
                    _ => Vec::new(),
                };

                Configuration {
                    identity: themes
                        .get(&call.name)
                        .and_then(|theme| theme.metadata.contract.identity.clone())
                        .unwrap_or_else(|| Arc::clone(&call.name)),
                    storage_key: options
                        .and_then(|options| options.get("storageKey"))
                        .and_then(Data::as_str)
                        .map(Arc::from),
                    themes: names,
                }
            })
            .collect()
    }

    fn published_rules(
        &self,
        id: &Arc<str>,
        modules: &Map<Arc<transform::Output>>,
        visited: &mut FxHashSet<Arc<str>>,
        rules: &mut IndexMap<Arc<str>, Arc<str>, FxBuildHasher>,
    ) {
        if !visited.insert(Arc::clone(id)) {
            return;
        }

        for dependency in self
            .dependencies
            .get(id)
            .iter()
            .flat_map(|dependencies| dependencies.iter())
        {
            self.published_rules(dependency, modules, visited, rules);
        }

        if let Some(library) = self.libraries.get(id) {
            for (name, rule) in library.class_rules.iter() {
                rules.insert(Arc::clone(name), Arc::clone(rule));
            }
        }

        if let Some(output) = modules.get(id) {
            for (name, rule) in &output.rules {
                rules.insert(Arc::from(name.as_str()), Arc::from(rule.as_str()));
            }
        }
    }

    fn closure(
        &self,
        module_id: &Arc<str>,
        closures: &mut FxHashMap<Arc<str>, Arc<FxHashSet<Arc<str>>>>,
    ) -> Arc<FxHashSet<Arc<str>>> {
        if let Some(closure) = closures.get(module_id) {
            return Arc::clone(closure);
        }

        // Cache only complete closures. A back-edge cannot stand for an empty closure because
        // another member of the cycle may reach dependencies not visited yet.
        let mut pending = vec![Arc::clone(module_id)];
        let mut result: FxHashSet<Arc<str>> = FxHashSet::default();

        while let Some(id) = pending.pop() {
            for dependency in self
                .dependencies
                .get(&id)
                .iter()
                .flat_map(|dependencies| dependencies.iter())
            {
                if result.insert(Arc::clone(dependency)) {
                    if let Some(closure) = closures.get(dependency) {
                        result.extend(closure.iter().cloned());
                    } else {
                        pending.push(Arc::clone(dependency));
                    }
                }
            }
        }

        let result = Arc::new(result);

        closures.insert(Arc::clone(module_id), Arc::clone(&result));
        result
    }

    /// The specifier a module imports another module's profile constants with, if any.
    fn profile_source(
        &self,
        native: &NativeOptions,
        module_id: &str,
        owner: &str,
    ) -> Option<String> {
        // Host identities are opaque, so reuse the consumer's own resolved specifier.
        if native.runtime
            && let Some(imports) = &self.options.imports
        {
            return imports.get(module_id).and_then(|imports| {
                imports
                    .iter()
                    .find(|(_, target)| target.as_deref() == Some(owner))
                    .map(|(specifier, _)| specifier.to_string())
            });
        }

        Some(relative_specifier(module_id, owner))
    }

    /// Packed library links by the specifiers of a module's value imports and re-exports.
    fn imported_libraries(
        &self,
        module_id: &str,
        parsed: &Parsed<'_>,
    ) -> Result<Record<Record<Link>>> {
        let mut libraries = Record::new();

        for statement in &parsed.program.body {
            let (specifier, span) = match statement {
                Statement::ImportDeclaration(declaration) => {
                    if declaration.import_kind == ImportOrExportKind::Type || type_only(declaration)
                    {
                        continue;
                    }

                    (&declaration.source.value, declaration.span)
                }
                Statement::ExportFromDeclaration(declaration) => {
                    if declaration.export_kind == ImportOrExportKind::Type
                        || (!declaration.specifiers.is_empty()
                            && declaration
                                .specifiers
                                .iter()
                                .all(|specifier| specifier.export_kind == ImportOrExportKind::Type))
                    {
                        continue;
                    }

                    (&declaration.source.value, declaration.span)
                }
                Statement::ExportAllDeclaration(declaration) => {
                    if declaration.export_kind == ImportOrExportKind::Type {
                        continue;
                    }

                    (&declaration.source.value, declaration.span)
                }
                _ => continue,
            };

            if let Some(target) = self.resolve(module_id, specifier, span)?
                && let Some(library) = self.libraries.get(&target)
            {
                libraries.insert(specifier.as_str(), library.links.clone());
            }
        }

        Ok(libraries)
    }

    /// Rewrites every module for an explicit native target, with the native variable profiles
    /// that owning modules export to their readers, and publishes contracts of packed links.
    fn native(
        mut self,
        native: &NativeOptions,
        ids: &[Arc<str>],
        contracts: String,
    ) -> Result<Cache> {
        let options = self.options;
        let previous = self.previous;
        let scalar = scalar::Options::read(&native.fonts, &native.units);
        let encode = |read: &VarsRead| -> Result<String> {
            native_vars::compile(&native_vars::Options {
                default_vars: &read.default_vars,
                scalar: &scalar,
                unnamed: read.unnamed,
                vars: &read.vars,
            })
            .map(|profiles| profiles.to_json())
            .map_err(|error| Error::Native(error.text()))
        };
        let mut profiles = Profiles {
            reserved: self
                .identifiers
                .values()
                .flatten()
                .map(ToString::to_string)
                .collect(),
            shared: FxHashMap::default(),
        };

        if ids.iter().any(|id| {
            self.extracted
                .get(id)
                .is_some_and(|module| !module.native_vars.is_empty())
        }) {
            style_sheet::compile(
                &style::Definition::default(),
                &style_sheet::Options {
                    fonts: native.fonts.clone(),
                    platform: native.platform.clone(),
                    units: native.units.clone(),
                    vars: Data::Undefined,
                },
            )?;
        }

        // Single-file adapters compile each owner without its consumers, so owners publish every
        // exported profile.
        if native.runtime {
            for id in ids {
                let Some(module) = self.extracted.get(id) else {
                    continue;
                };

                for link in module.theme_exports.values() {
                    let owned = self
                        .owners
                        .get(&link.call.name)
                        .is_some_and(|owner| owner.module_id == *id);
                    let profiled = link.call.variable_set
                        || (link.kind == LinkKind::Config
                            && link.call.variable_config
                            && !link.call.initialization
                            && !link.call.root);

                    if !owned || !profiled {
                        continue;
                    }

                    let read = themes::vars_read(
                        &link.call,
                        &link.definition,
                        link.members.as_ref(),
                        0,
                        0,
                    );

                    // Consumers that read this profile report the same error.
                    if let Ok(value) = encode(&read) {
                        profiles.define(id, value);
                    }
                }
            }
        }

        for id in ids {
            let Some(module) = self.extracted.get(id).cloned() else {
                continue;
            };

            for read in &module.native_vars {
                // Packed catalogs without source retain their local fallback.
                let Some(owner) = self
                    .owners
                    .get(&read.owner)
                    .map(|owner| Arc::clone(&owner.module_id))
                    .filter(|owner| options.modules.contains_key(owner))
                else {
                    continue;
                };
                let value = encode(read)?;
                let name = if native.runtime {
                    profiles
                        .shared
                        .get(&owner)
                        .and_then(|shared| shared.definitions.get(&value))
                        .cloned()
                } else {
                    Some(profiles.define(&owner, value))
                };
                let Some(name) = name else {
                    continue;
                };
                let source = if owner == *id {
                    None
                } else {
                    let source = self
                        .profile_source(native, id, &owner)
                        .filter(|source| !source.is_empty());

                    if source.is_none() {
                        continue;
                    }

                    source
                };

                profiles
                    .shared
                    .entry(Arc::clone(id))
                    .or_default()
                    .reads
                    .insert(read.start, native_vars::Import { name, source });
            }
        }

        let mut modules: Map<Compiled> = Map::default();

        for id in ids {
            let Some(module) = self.extracted.get(id).cloned() else {
                continue;
            };

            // Single-file profiles derive only from this module's extraction and its
            // dependencies.
            if let Some(previous) = previous
                && (native.runtime || profiles.shared.is_empty())
                && previous
                    .extracted
                    .get(id)
                    .is_some_and(|extracted| Arc::ptr_eq(extracted, &module))
                && let Some(output) = previous.result.modules.get(id)
            {
                modules.insert(Arc::clone(id), output.clone());
                continue;
            }

            let Some(parsed) = self.parse(id) else {
                continue;
            };
            let libraries = self.imported_libraries(id, parsed)?;
            let extracted = match self.fresh.remove(id) {
                Some(extracted) => extracted,
                None => self.link(id)?.extracted,
            };
            let context = themes::Context {
                identifiers: self.identifiers.get(id).cloned(),
                libraries: Some(libraries),
                ..themes::Context::default()
            };
            let output = native::compile(
                &native::Options {
                    color_scheme: native.color_scheme.as_deref(),
                    context: Some(&context),
                    contextual: native.contextual == Some(true),
                    fonts: native.fonts.clone(),
                    module_id: id,
                    platform: native.platform.clone(),
                    runtime: native.runtime,
                    set: native.set.as_deref(),
                    shared: profiles.shared.get(id),
                    source: parsed.source,
                    units: native.units.clone(),
                    vars: native.vars.as_ref(),
                },
                &extracted,
                parsed,
            )?;

            modules.insert(Arc::clone(id), Compiled::Native(Arc::new(output)));
        }

        let mut published: Map<String> = Map::default();

        for id in ids {
            let Some(module) = self.extracted.get(id) else {
                continue;
            };

            if module.theme_exports.is_empty() && module.literals.is_empty() {
                continue;
            }

            let mut links = Record::new();

            for (name, link) in module.theme_exports.iter() {
                links.insert(Arc::clone(name), packed_link(link));
            }

            published.insert(
                Arc::clone(id),
                contract::write(&contract::Write {
                    class_rules: &[],
                    configurations: &[],
                    links: &links,
                    literals: &module.literals,
                    module_id: id,
                    stylesheets: &[],
                    themes: &self.themes,
                })?,
            );
        }

        Ok(Cache {
            composition: options.composition,
            contracts,
            css_output: options.css_output,
            development: options.development,
            entry: options.entry.clone(),
            extracted: self.extracted,
            lean: options.lean,
            libraries: self.libraries,
            native: Some(native.clone()),
            referenced: None,
            references: options.references,
            renders: Vec::new(),
            reset: options.reset.clone(),
            resolutions: self.resolutions,
            result: Arc::new(Output {
                contracts: published,
                dependencies: self.dependencies,
                modules,
                packed: Vec::new(),
                reset: None,
                shared: None,
            }),
            retained: bounded(self.retained),
            rewrite: true,
            schemes: false,
            scoped: None,
            // The TypeScript native cache records no shared mode, so supplying one invalidates it.
            shared: None,
            sources: options.modules.clone(),
            themes: self.themes,
            transformed: previous
                .map(|previous| previous.transformed.clone())
                .unwrap_or_default(),
        })
    }

    /// Emits module CSS, shared stylesheets, and contracts for a web graph.
    #[expect(
        clippy::too_many_lines,
        reason = "The phases share one compilation's tables and mirror the graph contract."
    )]
    fn web(mut self, ids: &[Arc<str>], rewrite: bool, contracts: String) -> Result<Cache> {
        let options = self.options;
        let previous = self.previous;
        let shared_themes = self.themes.clone();
        let scopes: Vec<(Arc<str>, Scope)> = shared_themes
            .iter()
            .map(|(name, theme)| (Arc::clone(name), Scope::Definition(theme.metadata.clone())))
            .collect();
        let mut sections: Map<Vec<Section>> = Map::default();

        for id in ids {
            let Some(module) = self.extracted.get(id).cloned() else {
                continue;
            };

            if module.contributions.is_empty() {
                sections.insert(Arc::clone(id), Vec::new());
                continue;
            }

            let mut list = Vec::with_capacity(module.contributions.len());

            for (index, contribution) in module.contributions.iter().enumerate() {
                let (css, layers) = if let ContributionKind::Layers { names } = &contribution.kind {
                    (Arc::from(""), vec![names.clone()])
                } else {
                    let css = css::compile(
                        &css::Options {
                            contributions: std::slice::from_ref(contribution),
                            contributions_only: true,
                            vars: Some(&scopes),
                            ..css::Options::default()
                        },
                        None,
                    )?
                    .contribution_css
                    .unwrap_or_default();

                    (Arc::from(css), Vec::new())
                };
                let start = module.contribution_starts.get(index).copied().unwrap_or(0);

                list.push(Section {
                    authored_namespaces: true,
                    leading_dependency: false,
                    content: options.modules.get(id).cloned(),
                    css,
                    dependency: None,
                    key: Some(Arc::from(index.to_string())),
                    layers,
                    namespaces: Some(module.namespaces.clone()),
                    owner: None,
                    source: Arc::clone(id),
                    start: Some(self.utf16(id, start)),
                });
            }

            sections.insert(Arc::clone(id), list);
        }

        for (id, library) in self.libraries.clone() {
            let mut list = Vec::with_capacity(library.stylesheets.len());

            for section in &library.stylesheets {
                let mut owner = Arc::clone(&id);

                for specifier in section.dependency.iter().flatten() {
                    match self.resolve(&owner, specifier, Span::default())? {
                        Some(target) if self.libraries.contains_key(&target) => owner = target,
                        _ => {
                            return Err(self.fail(
                                &id,
                                "Repacked stylesheet dependencies require supplied library contracts.",
                                None,
                            ));
                        }
                    }
                }

                list.push(Section {
                    source: Arc::from(stylesheets::resolve(&owner, &section.source)?),
                    owner: Some(owner),
                    ..section.clone()
                });
            }

            sections.insert(id, list);
        }

        let reset_owners: Vec<Arc<str>> = ids
            .iter()
            .filter(|id| {
                self.source(id).is_some_and(|source| source.contains("zyzz/reset.css"))
                    && self.parse(id).is_some_and(|parsed| {
                        parsed.program.body.iter().any(|node| {
                            matches!(node, Statement::ImportDeclaration(declaration) if declaration.source.value == "zyzz/reset.css")
                        })
                    })
            })
            .cloned()
            .collect();
        // Layer names keep their first appearance, which one walk of the whole graph reproduces,
        // so each module's sections join once rather than once per importer.
        let graph_layers = {
            let mut reached = Vec::new();
            let mut visited = FxHashSet::default();

            for id in ids {
                reached.extend(self.reachable(&sections, id, &mut visited));
            }

            layer_names(&reached)
        };

        for owner in &reset_owners {
            let entry_layers =
                layer_names(&self.reachable(&sections, owner, &mut FxHashSet::default()));
            let mut list = vec![Section {
                key: Some(Arc::from("optional-reset-order")),
                layers: reset_layers(&entry_layers),
                source: Arc::clone(owner),
                ..Section::default()
            }];

            list.extend(sections.get(owner).cloned().unwrap_or_default());
            sections.insert(Arc::clone(owner), list);
        }

        let mut packed: Vec<Resource> = Vec::new();
        let shared_sections = {
            let result = (|| -> Result<Vec<Section>> {
                let mut visited = FxHashSet::default();
                let mut packed_sections = Vec::new();
                let mut shared = Vec::new();

                match &options.entry {
                    None => {
                        for id in ids {
                            shared.extend(self.reachable(&sections, id, &mut visited));
                        }
                    }
                    Some(entry) => {
                        for id in self
                            .dependencies
                            .get(entry)
                            .iter()
                            .flat_map(|ids| ids.iter())
                        {
                            if self.libraries.contains_key(id) {
                                packed_sections.extend(self.reachable(&sections, id, &mut visited));
                            }
                        }

                        shared = sections.get(entry).cloned().unwrap_or_default();
                    }
                }

                if !packed_sections.is_empty() {
                    // Validate combined ownership and ordering before splitting independently
                    // loaded resources.
                    let combined: Vec<Section> =
                        packed_sections.iter().chain(&shared).cloned().collect();

                    stylesheets::render(&combined)?;

                    for section in &packed_sections {
                        let mut id = String::from("[");

                        json_or_null(&mut id, section.owner.as_deref());
                        id.push(',');
                        js::write_string(&mut id, &section.source);
                        id.push(',');
                        json_or_null(&mut id, section.key.as_deref());
                        id.push(']');
                        packed.push(Resource {
                            id,
                            rendered: stylesheets::render(std::slice::from_ref(section))?,
                        });
                    }
                }

                let reset_source: Option<Arc<str>> = options
                    .reset
                    .as_ref()
                    .map(|_| Arc::from("zyzz/reset.css"))
                    .or_else(|| reset_owners.first().cloned())
                    .or_else(|| {
                        shared
                            .iter()
                            .find(|section| section.key.as_deref() == Some("optional-reset-order"))
                            .map(|section| Arc::clone(&section.source))
                    });

                if !packed.is_empty() {
                    let mut order: Vec<Section> = Vec::new();

                    if let Some(source) = &reset_source {
                        order.push(Section {
                            layers: reset_layers(&graph_layers),
                            source: Arc::clone(source),
                            ..Section::default()
                        });
                    }

                    order.extend(
                        packed_sections
                            .iter()
                            .chain(&shared)
                            .map(|section| Section {
                                css: Arc::from(""),
                                ..section.clone()
                            }),
                    );

                    let order = stylesheets::render(&order)?;

                    if !order.css.is_empty() {
                        packed.insert(
                            0,
                            Resource {
                                id: order.css.clone(),
                                rendered: order,
                            },
                        );
                    }
                }

                let mut result = Vec::new();

                if let Some(source) = reset_source {
                    result.push(Section {
                        key: Some(Arc::from("optional-reset-graph-order")),
                        layers: reset_layers(&graph_layers),
                        source,
                        ..Section::default()
                    });
                }

                result.extend(shared);

                if let Some(reset) = &options.reset
                    && options.entry.is_none()
                {
                    result.push(Section {
                        content: Some(Arc::clone(reset)),
                        css: Arc::clone(reset),
                        key: Some(Arc::from("optional-reset")),
                        layers: vec![vec![Arc::from("reset")]],
                        source: Arc::from("zyzz/reset.css"),
                        ..Section::default()
                    });
                }

                Ok(result)
            })();

            result.map_err(|error| self.render_error(&error, ids))?
        };
        let contributions = self.render_shared(&shared_sections, ids)?;
        // Every stylesheet includes all graph scopes, including unimported alternatives.
        let same_themes = previous.is_some_and(|previous| {
            previous.themes.len() == shared_themes.len()
                && shared_themes.iter().zip(previous.themes.iter()).all(
                    |((name, theme), (previous_name, previous_theme))| {
                        name == previous_name && Arc::ptr_eq(theme, previous_theme)
                    },
                )
        });
        let mut style_classes: FxHashMap<Arc<str>, Arc<str>> = FxHashMap::default();

        for library in self.libraries.values() {
            for link in library.links.values() {
                published(link, &mut style_classes);
            }
        }

        for (module_id, library) in self.libraries.clone() {
            self.register_rules(
                library
                    .class_rules
                    .iter()
                    .map(|(name, rule)| (&**name, &**rule)),
                &module_id,
            )?;
        }

        if !rewrite {
            self.portable_identities()?;
        }

        // Selection anywhere in the graph applies scheme classes beside scopes every stylesheet
        // carries, so each stylesheet declares the matching color-scheme.
        let schemes = self.extracted.values().any(|module| {
            !module.theme_appearances.is_empty()
                || !module.theme_scripts.is_empty()
                || !module.theme_selections.is_empty()
        });
        let owner_signature: Arc<[(Arc<str>, usize)]> = self
            .owners
            .iter()
            .map(|(key, owner)| {
                let module = self
                    .extracted
                    .get(&owner.module_id)
                    .map_or(0, |module| Arc::as_ptr(module) as usize);

                (Arc::clone(key), module)
            })
            .collect();
        let mut registry = Registry::new();
        let mut closures: FxHashMap<Arc<str>, Arc<FxHashSet<Arc<str>>>> = FxHashMap::default();
        let mut modules: Map<Arc<transform::Output>> = Map::default();
        let mut transformed = previous
            .map(|previous| previous.transformed.clone())
            .unwrap_or_default();
        let order: Vec<Arc<str>> = self.extracted.keys().cloned().collect();
        // Development keeps every identity, so edits that add a selector reference never change
        // other modules' class lists.
        let referenced = (rewrite && !options.development && options.references)
            .then(|| Arc::new(references(self.extracted.values().map(|module| &**module))));
        let same_references = previous.is_some_and(|previous| previous.referenced == referenced);

        // Extraction visits dependencies first, and their emitted classes must precede consumers.
        for module_id in &order {
            let Some(module) = self.extracted.get(module_id).cloned() else {
                continue;
            };
            let markers: Option<Box<[Arc<str>]>> = referenced.as_ref().map(|referenced| {
                module
                    .calls
                    .iter()
                    .flat_map(|call| {
                        call.identity
                            .iter()
                            .flat_map(|identity| identity.split(' '))
                    })
                    .filter_map(|name| referenced.get(name).cloned())
                    .collect()
            });
            // Hosts that compile a module within several graphs must name it the same in each,
            // so it may reuse only names its dependencies introduce.
            let visible = if options.complete {
                Visibility::All
            } else {
                Visibility::Owners(self.closure(module_id, &mut closures))
            };
            let reusable = transformed.get(module_id).filter(|cached| {
                Arc::ptr_eq(&cached.extracted, &module)
                    && cached.schemes == schemes
                    && cached.themes.len() == shared_themes.len()
                    && shared_themes.iter().all(|(name, theme)| {
                        cached
                            .themes
                            .get(name)
                            .is_some_and(|cached| Arc::ptr_eq(cached, theme))
                    })
                    && cached
                        .classes
                        .iter()
                        .all(|(name, value)| style_classes.get(name) == value.as_ref())
                    && cached.owners == owner_signature
                    && cached.markers == markers
            });
            let reused = match reusable {
                Some(cached) if registry.restore(module_id, &cached.output.units, &visible) => {
                    Some(Arc::clone(&cached.output))
                }
                _ => previous
                    .filter(|previous| {
                        same_themes
                            && same_references
                            && previous.schemes == schemes
                            && previous
                                .extracted
                                .get(module_id)
                                .is_some_and(|extracted| Arc::ptr_eq(extracted, &module))
                    })
                    .and_then(|previous| previous.result.modules.get(module_id))
                    .and_then(Compiled::web)
                    .filter(|output| registry.restore(module_id, &output.units, &visible))
                    .cloned(),
            };
            let output = if let Some(output) = reused {
                output
            } else {
                let mut extracted = match self.fresh.remove(module_id) {
                    Some(extracted) => extracted,
                    None => self.link(module_id)?.extracted,
                };

                extracted.vars = shared_themes.clone();
                extracted.contributions = Vec::new();

                let Some(parsed) = self.parse(module_id) else {
                    continue;
                };
                let compact = identity::compact(module_id);
                let qualifier = compact
                    .get(compact.len().saturating_sub(6)..)
                    .unwrap_or_default();
                let mut units = registry.scope(module_id, qualifier, visible);
                let output = transform::compile(
                    &transform::Options {
                        compiler: rewrite,
                        composition: options.composition,
                        css_output: options.css_output,
                        deferred_scopes: options.lean && options.entry.is_none(),
                        development: options.development,
                        invalid_css_output: options.invalid_css_output,
                        module_id,
                        owners: Some(&self.owners),
                        placeholder: None,
                        referenced: referenced.as_deref(),
                        schemes: Some(schemes),
                        shared: Some(if options.entry.is_none() {
                            options.shared.unwrap_or(Shared::Defaults)
                        } else {
                            Shared::All
                        }),
                        source: parsed.source,
                        style_classes: Some(&style_classes),
                    },
                    &extracted,
                    parsed,
                    Some(&mut units),
                )?;
                // A dependency edit re-transforms its consumers. An unchanged result keeps the
                // previous value, so hosts see which modules actually changed.
                let unchanged = transformed
                    .get(module_id)
                    .map(|cached| &cached.output)
                    .or_else(|| {
                        previous
                            .and_then(|previous| previous.result.modules.get(module_id))
                            .and_then(Compiled::web)
                    })
                    .filter(|cached| transform::same(cached, &output));

                match unchanged {
                    Some(cached) => Arc::clone(cached),
                    None => Arc::new(output),
                }
            };
            let mut classes: Vec<(Arc<str>, Option<Arc<str>>)> = Vec::new();

            for name in module.calls.iter().flat_map(|call| call.inputs.iter()) {
                let value = style_classes.get(name).cloned();

                match classes.iter_mut().find(|(existing, _)| existing == name) {
                    Some(entry) => entry.1 = value,
                    None => classes.push((Arc::clone(name), value)),
                }
            }

            transformed.insert(
                Arc::clone(module_id),
                Transformed {
                    classes,
                    extracted: Arc::clone(&module),
                    markers,
                    output: Arc::clone(&output),
                    owners: Arc::clone(&owner_signature),
                    schemes,
                    themes: shared_themes.clone(),
                },
            );

            self.register_rules(
                output
                    .rules
                    .iter()
                    .map(|(name, rule)| (name.as_str(), rule.as_str())),
                module_id,
            )?;

            for call in &module.calls {
                if let Some(identity) = &call.identity
                    && !call.composition
                    && !call.runtime_composition
                    && !call.composition_case
                {
                    match output.classes.get(&call.name) {
                        Some(class_name) => {
                            style_classes
                                .insert(Arc::clone(identity), Arc::from(class_name.as_str()));
                        }
                        None => {
                            style_classes.remove(identity);
                        }
                    }
                }
            }

            modules.insert(Arc::clone(module_id), output);
        }

        let scoped = if modules.values().any(|output| output.references.is_some()) {
            Some(Self::scoped(
                &modules,
                &scopes,
                schemes,
                previous.filter(|previous| same_themes && previous.schemes == schemes),
            )?)
        } else {
            None
        };
        let mut defaults: FxHashSet<&str> = FxHashSet::default();
        let mut default_rules: Map<Vec<ThemeRule>> = Map::default();
        let mut default_sections: Vec<Section> = Vec::new();

        if options.entry.is_none() {
            // Graph-wide resources take the place of the first module's own, which every module
            // repeated.
            let graph = scoped
                .iter()
                .zip(modules.keys().next())
                .flat_map(|(scoped, source)| {
                    scoped
                        .resources
                        .iter()
                        .map(move |resource| (source, resource))
                });
            let local = modules.iter().flat_map(|(source, output)| {
                output
                    .shared
                    .iter()
                    .flatten()
                    .map(move |resource| (source, resource))
            });

            for (source, resource) in graph.chain(local) {
                if !defaults.insert(&resource.id) {
                    continue;
                }

                match &resource.rules {
                    None => default_sections.push(Section {
                        css: Arc::from(resource.css.as_str()),
                        key: Some(Arc::from(resource.id.as_str())),
                        source: Arc::clone(source),
                        ..Section::default()
                    }),
                    Some(rules) => default_rules
                        .entry(Arc::clone(source))
                        .or_default()
                        .extend(rules.iter().cloned()),
                }
            }
        }

        let shared = if defaults.is_empty() {
            contributions
        } else {
            let mut list = shared_sections.clone();

            list.extend(default_sections);
            list.extend(default_rules.iter().map(|(source, rules)| Section {
                css: Arc::from(theme_rules::render(rules)),
                key: Some(Arc::from("theme-defaults")),
                source: Arc::clone(source),
                ..Section::default()
            }));
            self.render_shared(&list, ids)?
        };
        let mut published_contracts: Map<String> = Map::default();

        if options.entry.is_none() {
            for id in ids {
                let Some(module) = self.extracted.get(id).cloned() else {
                    continue;
                };

                // Catalog readers need configurations and configuration exports, not the
                // rules, stylesheets, and links that every other contract repeats.
                if options.lean {
                    // A lean contract reads only its module and the graph's themes, so an
                    // unchanged pair publishes the previous text, or nothing as before.
                    if same_themes
                        && let Some(previous) = previous
                        && previous
                            .extracted
                            .get(id)
                            .is_some_and(|extracted| Arc::ptr_eq(extracted, &module))
                    {
                        if let Some(text) = previous.result.contracts.get(id) {
                            published_contracts.insert(Arc::clone(id), text.clone());
                        }

                        continue;
                    }

                    let configurations = Self::configurations(&module, &shared_themes);
                    let mut links = Record::new();

                    for (name, link) in module.theme_exports.iter() {
                        if link.kind == LinkKind::Config {
                            links.insert(Arc::clone(name), link.clone());
                        }
                    }

                    if !configurations.is_empty() || !links.is_empty() {
                        published_contracts.insert(
                            Arc::clone(id),
                            contract::write(&contract::Write {
                                class_rules: &[],
                                configurations: &configurations,
                                links: &links,
                                literals: &Record::new(),
                                module_id: id,
                                stylesheets: &[],
                                themes: &shared_themes,
                            })?,
                        );
                    }

                    continue;
                }

                let reached = self.reachable(&sections, id, &mut FxHashSet::default());
                let configurations = Self::configurations(&module, &shared_themes);

                if module.theme_exports.is_empty()
                    && module.literals.is_empty()
                    && reached.is_empty()
                    && configurations.is_empty()
                {
                    continue;
                }

                let mut links = Record::new();

                for (name, link) in module.theme_exports.iter() {
                    links.insert(Arc::clone(name), published_style(link, &style_classes));
                }

                let mut owned = Vec::with_capacity(reached.len());

                for section in reached {
                    let owner = section.owner.clone();
                    let dependency = match &owner {
                        Some(owner) if owner != id => Some(self.dependency_path(id, owner)?),
                        _ => None,
                    };

                    owned.push(Section {
                        dependency,
                        owner: None,
                        source: Arc::from(stylesheets::relative(
                            owner.as_deref().unwrap_or(id),
                            &section.source,
                        )),
                        ..section
                    });
                }

                let mut rules = IndexMap::default();

                self.published_rules(id, &modules, &mut FxHashSet::default(), &mut rules);

                let rules: Vec<(Arc<str>, Arc<str>)> = rules.into_iter().collect();

                published_contracts.insert(
                    Arc::clone(id),
                    contract::write(&contract::Write {
                        class_rules: &rules,
                        configurations: &configurations,
                        links: &links,
                        literals: &module.literals,
                        module_id: id,
                        stylesheets: &owned,
                        themes: &shared_themes,
                    })?,
                );
            }
        }

        let reset = match (&options.entry, &options.reset) {
            (Some(_), Some(reset)) => Some(Resource {
                id: "zyzz/reset.css".to_owned(),
                rendered: stylesheets::render(&[Section {
                    content: Some(Arc::clone(reset)),
                    css: Arc::clone(reset),
                    layers: vec![vec![Arc::from("reset")]],
                    source: Arc::from("zyzz/reset.css"),
                    ..Section::default()
                }])?,
            }),
            _ => None,
        };
        let output = Output {
            contracts: published_contracts,
            dependencies: self.dependencies.clone(),
            modules: ids
                .iter()
                .filter_map(|id| {
                    modules
                        .get(id)
                        .map(|output| (Arc::clone(id), Compiled::Web(Arc::clone(output))))
                })
                .collect(),
            packed,
            reset,
            shared: (!shared.css.is_empty()).then_some(shared),
        };

        Ok(Cache {
            composition: options.composition,
            contracts,
            css_output: options.css_output,
            development: options.development,
            entry: options.entry.clone(),
            extracted: self.extracted,
            lean: options.lean,
            libraries: self.libraries,
            native: None,
            referenced,
            references: options.references,
            renders: self.renders,
            reset: options.reset.clone(),
            resolutions: self.resolutions,
            result: Arc::new(output),
            retained: bounded(self.retained),
            rewrite,
            schemes,
            scoped,
            shared: options.shared,
            sources: options.modules.clone(),
            themes: shared_themes,
            transformed: bounded(transformed),
        })
    }
}
