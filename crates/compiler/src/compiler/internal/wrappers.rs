//! Folds trivial wrapper components into the host elements they render.
//!
//! A wrapper is a module-scope function component whose whole body is one JSX element. The
//! element spreads one folded style application, either without arguments or with the caller's
//! `className` as its only override, forwards the caller's `children`, and names a host element
//! or another wrapper. Each wrapper resolves to the host element and class list its runtime chain
//! renders. Every level merges its own classes before the classes it receives, as `Props.merge`
//! does, so outer levels still follow inner ones in the class list and win the same conflicts.
//!
//! A use site that passes only `children`, `className`, and `key` then renders the host element
//! directly, and a wrapper whose element names a forwarding wrapper renders that wrapper's host
//! element itself. Definitions stay in place, so exports and other callers keep working.
//!
//! A folded element still reads the first imported wrapper its chain passes through, as
//! `Button&&"classes"`. Bundlers then keep that module and the stylesheet it imports, and its own
//! folded elements keep the next module in the chain.

use std::sync::Arc;

use indexmap::IndexMap;
use oxc_ast::AstKind;
use oxc_ast::ast::{
    Argument, BindingPattern, Declaration, ExportDefaultDeclarationKind, Expression,
    FormalParameters, FunctionBody, IdentifierReference, ImportDeclarationSpecifier,
    ImportOrExportKind, JSXAttributeItem, JSXAttributeName, JSXAttributeValue, JSXChild,
    JSXElement, JSXElementName, JSXExpression, ModuleExportName, ObjectPropertyKind, Program,
    PropertyKey, PropertyKind, Statement, VariableDeclarationKind,
};
use oxc_semantic::{ScopeId, Semantic, SymbolId};
use oxc_span::{GetSpan, Span};
use rustc_hash::{FxBuildHasher, FxHashMap, FxHashSet};

use crate::js;

/// The host element a wrapper renders and the classes it applies there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fold {
    /// Classes the host element receives before a forwarded `className`. Never empty.
    pub classes: Arc<str>,
    /// Whether a caller's `className` reaches the host element, merged after [`Fold::classes`].
    pub forwards: bool,
    /// Host element name.
    pub tag: Arc<str>,
}

/// Folds of a module's exported wrappers, by export name.
pub type Exports = IndexMap<Arc<str>, Fold, FxBuildHasher>;

/// Exported folds of imported source modules, by import specifier.
pub type Imports = FxHashMap<Arc<str>, Arc<Exports>>;

/// A folded application of a style definition: its call end and class list.
pub type Applied<'o> = (u32, &'o str);

/// Inputs of [`find`].
pub struct Options<'o> {
    /// Folded `className` applications, by call start.
    pub applications: &'o FxHashMap<u32, Applied<'o>>,
    /// Whether another edit replaces a range whole, so no element inside it folds.
    pub excluded: &'o dyn Fn(Span) -> bool,
    /// Exported folds of imported modules.
    pub imports: Option<&'o Imports>,
    /// Local name of the runtime `Props` namespace.
    pub runtime: &'o str,
    /// Complete module text.
    pub source: &'o str,
}

/// A module's wrappers and the edits that fold them.
#[derive(Debug, Default)]
pub struct Wrappers {
    /// Replacements in source order, by original range.
    pub edits: Vec<(u32, u32, String)>,
    /// Folds of exported wrappers, by export name in source order.
    pub exports: Exports,
    /// Whether an edit calls the runtime `merge`.
    pub merges: bool,
    /// Classes of the wrapper that a wrapper's element names, by the start of that element's
    /// application. The application's own classes follow them on the host element.
    pub prefixes: FxHashMap<u32, Prefix>,
}

/// Classes that precede a wrapper application's own classes on the host element.
#[derive(Debug)]
pub struct Prefix {
    /// Local name of the imported wrapper the class list reads first, which keeps its module.
    pub anchor: Option<Arc<str>>,
    /// Classes of the wrapper the element names.
    pub classes: Arc<str>,
}

/// What a wrapper's element names.
#[derive(Clone, Copy)]
enum Target<'a> {
    Host(&'a str),
    Import(SymbolId),
    Local(SymbolId),
}

/// A function component whose body is one foldable element.
struct Candidate<'a> {
    /// The application's call start.
    application: u32,
    classes: &'a str,
    element: &'a JSXElement<'a>,
    forwards: bool,
    /// End of the declaration, after which module-scope use sites read an initialized binding.
    ready: u32,
    target: Target<'a>,
}

/// How a component reads its props.
enum Props {
    /// `(props) => ...`, read as `props.className` and `props.children`.
    Object(SymbolId),
    /// `({ children, className }) => ...`, with each name's binding.
    Pattern {
        children: Option<SymbolId>,
        class_name: Option<SymbolId>,
    },
}

/// The deepest wrapper chain resolved, which bounds recursion through local targets.
const DEPTH: usize = 64;

/// Finds a module's wrappers, resolves their folds, and plans the edits of every foldable
/// element.
pub fn find<'a>(
    program: &'a Program<'a>,
    semantic: &Semantic<'a>,
    options: &Options<'a>,
) -> Wrappers {
    let mut candidates: FxHashMap<SymbolId, Candidate<'a>> = FxHashMap::default();
    // Exported wrappers by local symbol, with each export name in source order.
    let mut exported: Vec<(SymbolId, &'a str)> = Vec::new();
    let mut imported: FxHashMap<SymbolId, (&'a str, &'a str)> = FxHashMap::default();

    for statement in &program.body {
        match statement {
            Statement::ImportDeclaration(import)
                if import.import_kind == ImportOrExportKind::Value =>
            {
                for specifier in import.specifiers.iter().flatten() {
                    let (local, name) = match specifier {
                        ImportDeclarationSpecifier::ImportSpecifier(specifier)
                            if specifier.import_kind == ImportOrExportKind::Value =>
                        {
                            (&specifier.local, specifier.imported.name().as_str())
                        }
                        ImportDeclarationSpecifier::ImportDefaultSpecifier(specifier) => {
                            (&specifier.local, "default")
                        }
                        _ => continue,
                    };

                    if let Some(symbol) = local.symbol_id.get() {
                        imported.insert(symbol, (import.source.value.as_str(), name));
                    }
                }
            }
            Statement::ExportDeclaration(export) => {
                for (symbol, name) in
                    declare(&export.declaration, semantic, options, &mut candidates)
                {
                    exported.push((symbol, name));
                }
            }
            Statement::ExportNamedDeclaration(export)
                if export.export_kind == ImportOrExportKind::Value =>
            {
                for specifier in &export.specifiers {
                    if specifier.export_kind == ImportOrExportKind::Value
                        && let ModuleExportName::IdentifierReference(local) = &specifier.local
                        && let Some(symbol) = resolve(semantic, local)
                    {
                        exported.push((symbol, specifier.exported.name().as_str()));
                    }
                }
            }
            Statement::ExportDefaultDeclaration(export) => {
                if let ExportDefaultDeclarationKind::Identifier(local) = &export.declaration
                    && let Some(symbol) = resolve(semantic, local)
                {
                    exported.push((symbol, "default"));
                }
            }
            other => {
                if let Some(declaration) = other.as_declaration() {
                    declare(declaration, semantic, options, &mut candidates);
                }
            }
        }
    }

    let mut wrappers = Wrappers::default();

    if candidates.is_empty() && imported.is_empty() {
        return wrappers;
    }

    let mut folds: FxHashMap<SymbolId, Option<Fold>> = FxHashMap::default();
    let resolver = Resolver {
        candidates: &candidates,
        imported: &imported,
        imports: options.imports,
    };
    let mut symbols: Vec<SymbolId> = candidates.keys().copied().collect();

    // Source order keeps hash order out of planning. Edits are sorted again before they apply.
    symbols.sort_unstable_by_key(|symbol| {
        candidates
            .get(symbol)
            .map(|candidate| candidate.element.span.start)
    });

    for symbol in &symbols {
        resolver.fold(*symbol, &mut folds, 0);
    }

    for (symbol, name) in exported {
        if let Some(Some(fold)) = folds.get(&symbol) {
            wrappers.exports.insert(Arc::from(name), fold.clone());
        }
    }

    let nodes = semantic.nodes();

    // A wrapper's element that names a forwarding wrapper renders that wrapper's host element.
    for symbol in &symbols {
        let Some(candidate) = candidates.get(symbol) else {
            continue;
        };
        let (target, anchor) = match candidate.target {
            Target::Host(_) => continue,
            Target::Import(target) | Target::Local(target) => {
                (resolver.target(target, &folds), resolver.anchor(target, 0))
            }
        };
        let scope = nodes.get_node(candidate.element.node_id.get()).scope_id();

        if let Some(target) = target.filter(|target| target.forwards)
            && let Some(anchor) = anchor.map_or(Some(None), |anchor| {
                visible(semantic, scope, anchor).map(Some)
            })
            && !(options.excluded)(candidate.element.span)
        {
            wrappers.prefixes.insert(
                candidate.application,
                Prefix {
                    anchor,
                    classes: Arc::clone(&target.classes),
                },
            );
            rename(&mut wrappers.edits, candidate.element, &target.tag);
        }
    }

    for node in nodes.iter() {
        let AstKind::JSXElement(element) = node.kind() else {
            continue;
        };
        let JSXElementName::IdentifierReference(name) = &element.opening_element.name else {
            continue;
        };
        let Some(symbol) = resolve(semantic, name) else {
            continue;
        };
        let (fold, anchor) = if let Some(candidate) = candidates.get(&symbol) {
            // A module-scope element before the declaration still reads the uninitialized binding.
            let ready = element.span.start >= candidate.ready
                || nodes.ancestor_kinds(node.id()).any(|kind| defers(&kind));

            if !ready {
                continue;
            }

            (
                folds.get(&symbol).and_then(Option::as_ref),
                resolver.anchor(symbol, 0),
            )
        } else if imported.contains_key(&symbol) {
            (resolver.imported(symbol), Some(symbol))
        } else {
            (None, None)
        };

        if let Some(fold) = fold
            && let Some(anchor) = anchor.map_or(Some(None), |anchor| {
                visible(semantic, node.scope_id(), anchor).map(Some)
            })
            && !(options.excluded)(element.span)
        {
            use_site(&mut wrappers, element, fold, anchor.as_deref(), options);
        }
    }

    wrappers.edits.sort_unstable_by_key(|(start, _, _)| *start);
    wrappers
}

/// Records the wrappers a declaration binds, returning each binding's symbol and name.
fn declare<'a>(
    declaration: &'a Declaration<'a>,
    semantic: &Semantic<'a>,
    options: &Options<'a>,
    candidates: &mut FxHashMap<SymbolId, Candidate<'a>>,
) -> Vec<(SymbolId, &'a str)> {
    let mut bindings = Vec::new();

    match declaration {
        Declaration::VariableDeclaration(variable) => {
            for declarator in &variable.declarations {
                let BindingPattern::BindingIdentifier(identifier) = &declarator.id else {
                    continue;
                };
                let Some(symbol) = identifier.symbol_id.get() else {
                    continue;
                };

                bindings.push((symbol, identifier.name.as_str()));

                // A `let` or `var` binding can be replaced before a use site runs.
                if variable.kind != VariableDeclarationKind::Const {
                    continue;
                }

                let body = match &declarator.init {
                    Some(Expression::ArrowFunctionExpression(arrow)) if !arrow.r#async => arrow
                        .get_expression()
                        .or_else(|| arrow.get_function_body().and_then(returned))
                        .map(|body| (&*arrow.params, body)),
                    Some(Expression::FunctionExpression(function))
                        if !function.r#async
                            && !function.generator
                            && function.this_param.is_none() =>
                    {
                        function
                            .body
                            .as_deref()
                            .and_then(returned)
                            .map(|body| (&*function.params, body))
                    }
                    _ => None,
                };

                if let Some((params, body)) = body
                    && let Some(candidate) =
                        candidate(params, body, declarator.span.end, semantic, options)
                {
                    candidates.insert(symbol, candidate);
                }
            }
        }
        Declaration::FunctionDeclaration(function) => {
            let Some(identifier) = &function.id else {
                return bindings;
            };
            let Some(symbol) = identifier.symbol_id.get() else {
                return bindings;
            };

            bindings.push((symbol, identifier.name.as_str()));

            // Declarations hoist, so every use site reads an initialized binding.
            if !function.r#async
                && !function.generator
                && function.this_param.is_none()
                && !semantic.scoping().symbol_is_mutated(symbol)
                && let Some(body) = function.body.as_deref().and_then(returned)
                && let Some(candidate) = candidate(&function.params, body, 0, semantic, options)
            {
                candidates.insert(symbol, candidate);
            }
        }
        _ => {}
    }

    bindings
}

/// The expression a function body's only statement returns.
fn returned<'a>(body: &'a FunctionBody<'a>) -> Option<&'a Expression<'a>> {
    let [Statement::ReturnStatement(statement)] = body.statements.as_slice() else {
        return None;
    };

    body.directives
        .is_empty()
        .then_some(statement.argument.as_ref())
        .flatten()
}

/// The wrapper a function forms, when the expression it returns is one foldable element.
fn candidate<'a>(
    params: &'a FormalParameters<'a>,
    expression: &'a Expression<'a>,
    ready: u32,
    semantic: &Semantic<'a>,
    options: &Options<'a>,
) -> Option<Candidate<'a>> {
    let [param] = params.items.as_slice() else {
        return None;
    };

    if params.rest.is_some() || param.initializer.is_some() || !param.decorators.is_empty() {
        return None;
    }

    let props = match &param.pattern {
        BindingPattern::BindingIdentifier(identifier) => Props::Object(identifier.symbol_id.get()?),
        BindingPattern::ObjectPattern(pattern) => {
            if pattern.rest.is_some() {
                return None;
            }

            let mut children = None;
            let mut class_name = None;

            for property in &pattern.properties {
                let PropertyKey::StaticIdentifier(key) = &property.key else {
                    return None;
                };
                let BindingPattern::BindingIdentifier(value) = &property.value else {
                    return None;
                };
                let slot = match key.name.as_str() {
                    "children" => &mut children,
                    "className" => &mut class_name,
                    _ => return None,
                };

                if property.computed || slot.is_some() {
                    return None;
                }

                *slot = Some(value.symbol_id.get()?);
            }

            Props::Pattern {
                children,
                class_name,
            }
        }
        _ => return None,
    };

    let Expression::JSXElement(element) = expression else {
        return None;
    };
    let opening = &element.opening_element;

    if opening.type_arguments.is_some() {
        return None;
    }

    let [JSXAttributeItem::SpreadAttribute(spread)] = opening.attributes.as_slice() else {
        return None;
    };
    let Expression::CallExpression(call) = &spread.argument else {
        return None;
    };
    let (end, classes) = *options.applications.get(&call.span.start)?;

    if end != call.span.end || classes.is_empty() {
        return None;
    }

    let forwards = match call.arguments.as_slice() {
        [] => false,
        [Argument::ObjectExpression(object)] => {
            let [ObjectPropertyKind::ObjectProperty(property)] = object.properties.as_slice()
            else {
                return None;
            };

            if property.computed || property.method || property.kind != PropertyKind::Init {
                return None;
            }

            if !reads(semantic, &property.value, &props, "className") {
                return None;
            }

            true
        }
        _ => return None,
    };
    let mut forwarded = false;

    for child in &element.children {
        match child {
            JSXChild::Text(text) if insignificant(text.value.as_str()) => {}
            JSXChild::ExpressionContainer(container) if !forwarded => {
                let expression = container.expression.as_expression()?;

                if !reads(semantic, expression, &props, "children") {
                    return None;
                }

                forwarded = true;
            }
            _ => return None,
        }
    }

    if !forwarded {
        return None;
    }

    let target = match &opening.name {
        JSXElementName::Identifier(identifier) => Target::Host(identifier.name.as_str()),
        JSXElementName::IdentifierReference(identifier) => {
            let symbol = resolve(semantic, identifier)?;

            if semantic.scoping().symbol_flags(symbol).is_import() {
                Target::Import(symbol)
            } else {
                Target::Local(symbol)
            }
        }
        _ => return None,
    };

    Some(Candidate {
        application: call.span.start,
        classes,
        element,
        forwards,
        ready,
        target,
    })
}

/// Whether an expression reads the caller's prop `key`.
fn reads(semantic: &Semantic<'_>, expression: &Expression<'_>, props: &Props, key: &str) -> bool {
    match props {
        Props::Object(symbol) => {
            let Expression::StaticMemberExpression(member) = expression else {
                return false;
            };
            let Expression::Identifier(object) = &member.object else {
                return false;
            };

            !member.optional
                && member.property.name == key
                && resolve(semantic, object) == Some(*symbol)
        }
        Props::Pattern {
            children,
            class_name,
        } => {
            let binding = if key == "children" {
                children
            } else {
                class_name
            };
            let Expression::Identifier(identifier) = expression else {
                return false;
            };

            binding.is_some() && resolve(semantic, identifier) == *binding
        }
    }
}

/// Whether JSX drops a text child, as it drops whitespace that spans lines.
fn insignificant(text: &str) -> bool {
    text.bytes()
        .all(|byte| matches!(byte, b' ' | b'\t' | b'\n' | b'\r'))
        && text.contains(['\n', '\r'])
}

/// Matches nodes whose contents evaluate after a later call.
fn defers(kind: &AstKind<'_>) -> bool {
    matches!(
        kind,
        AstKind::ArrowFunctionExpression(_) | AstKind::Class(_) | AstKind::Function(_)
    )
}

fn resolve(semantic: &Semantic<'_>, reference: &IdentifierReference<'_>) -> Option<SymbolId> {
    semantic
        .scoping()
        .get_reference(reference.reference_id.get()?)
        .symbol_id()
}

/// The local name of an anchor binding, when a scope reads it without a nearer binding of the
/// same name.
fn visible(semantic: &Semantic<'_>, scope: ScopeId, anchor: SymbolId) -> Option<Arc<str>> {
    let scoping = semantic.scoping();
    let name = scoping.symbol_name(anchor);

    (scoping.find_binding(scope, name.into()) == Some(anchor)).then(|| Arc::from(name))
}

/// Writes a class list expression, read after an anchor that keeps its module.
fn guarded(text: &mut String, anchor: Option<&str>, classes: &str) {
    if let Some(anchor) = anchor {
        text.push_str(anchor);
        text.push_str("&&");
    }

    js::write_string(text, classes);
}

/// Renames an element's opening and closing names to a host element.
fn rename(edits: &mut Vec<(u32, u32, String)>, element: &JSXElement<'_>, tag: &str) {
    let name = element.opening_element.name.span();

    edits.push((name.start, name.end, tag.to_owned()));

    if let Some(closing) = &element.closing_element {
        let name = closing.name.span();

        edits.push((name.start, name.end, tag.to_owned()));
    }
}

/// Plans the edits of a use site that passes only `children`, `className`, and `key`.
fn use_site(
    wrappers: &mut Wrappers,
    element: &JSXElement<'_>,
    fold: &Fold,
    anchor: Option<&str>,
    options: &Options<'_>,
) {
    let opening = &element.opening_element;

    if opening.type_arguments.is_some() {
        return;
    }

    let mut class_name = None;
    let mut key = false;

    for attribute in &opening.attributes {
        let JSXAttributeItem::Attribute(attribute) = attribute else {
            return;
        };
        let JSXAttributeName::Identifier(name) = &attribute.name else {
            return;
        };

        match name.name.as_str() {
            "className" if class_name.is_none() => class_name = Some(attribute),
            "key" if !key && attribute.value.is_some() => key = true,
            _ => return,
        }
    }

    let name = opening.name.span();
    let mut edits: Vec<(u32, u32, String)> = Vec::with_capacity(3);

    match class_name.map(|attribute| &attribute.value) {
        None => {
            let mut text = String::with_capacity(fold.tag.len() + fold.classes.len() + 14);

            text.push_str(&fold.tag);
            text.push_str(" className={");
            guarded(&mut text, anchor, &fold.classes);
            text.push('}');
            edits.push((name.start, name.end, text));
        }
        // A caller's `className` reaches the host element only through forwarding levels.
        Some(_) if !fold.forwards => return,
        Some(Some(JSXAttributeValue::StringLiteral(literal))) => {
            // JSX strings decode character references and keep line breaks, which a JavaScript
            // string spells differently.
            let raw = options
                .source
                .get(literal.span.start as usize + 1..(literal.span.end as usize).saturating_sub(1))
                .unwrap_or_default();

            if raw.contains(['&', '\n', '\r']) {
                return;
            }

            let mut classes = String::with_capacity(fold.classes.len() + raw.len() + 1);

            classes.push_str(&fold.classes);

            if !raw.is_empty() {
                classes.push(' ');
                classes.push_str(raw);
            }

            let mut text = String::with_capacity(classes.len() + 4);

            text.push('{');
            guarded(&mut text, anchor, &classes);
            text.push('}');
            edits.push((name.start, name.end, fold.tag.to_string()));
            edits.push((literal.span.start, literal.span.end, text));
        }
        Some(Some(JSXAttributeValue::ExpressionContainer(container))) => {
            if matches!(container.expression, JSXExpression::EmptyExpression(_)) {
                return;
            }

            let value = container.expression.span();
            let mut open = String::with_capacity(options.runtime.len() + fold.classes.len() + 12);

            open.push('{');

            if let Some(anchor) = anchor {
                open.push_str(anchor);
                open.push_str("&&");
            }

            open.push_str(options.runtime);
            open.push_str(".merge(");
            js::write_string(&mut open, &fold.classes);
            open.push(',');
            edits.push((name.start, name.end, fold.tag.to_string()));
            // The value keeps its authored text, so rewrites inside it still apply.
            edits.push((container.span.start, value.start, open));
            edits.push((value.end, container.span.end, ")}".to_owned()));
            wrappers.merges = true;
        }
        Some(_) => return,
    }

    if let Some(closing) = &element.closing_element {
        let name = closing.name.span();

        edits.push((name.start, name.end, fold.tag.to_string()));
    }

    wrappers.edits.append(&mut edits);
}

/// Resolves wrapper folds through local and imported targets.
struct Resolver<'r, 'a> {
    candidates: &'r FxHashMap<SymbolId, Candidate<'a>>,
    imported: &'r FxHashMap<SymbolId, (&'a str, &'a str)>,
    imports: Option<&'r Imports>,
}

impl Resolver<'_, '_> {
    /// The fold of a local wrapper, memoized. A cycle or a chain past [`DEPTH`] does not fold.
    fn fold(
        &self,
        symbol: SymbolId,
        folds: &mut FxHashMap<SymbolId, Option<Fold>>,
        depth: usize,
    ) -> Option<Fold> {
        if let Some(fold) = folds.get(&symbol) {
            return fold.clone();
        }

        let candidate = self.candidates.get(&symbol)?;

        if depth > DEPTH {
            return None;
        }

        // A cycle reads the pending entry and stops.
        folds.insert(symbol, None);

        let fold = match candidate.target {
            Target::Host(tag) => Some(Fold {
                classes: Arc::from(candidate.classes),
                forwards: candidate.forwards,
                tag: Arc::from(tag),
            }),
            Target::Import(target) => self
                .imported(target)
                .map(|target| compose(target, candidate)),
            Target::Local(target) => self
                .fold(target, folds, depth + 1)
                .map(|target| compose(&target, candidate)),
        };

        folds.insert(symbol, fold.clone());
        fold
    }

    /// The first imported wrapper a local wrapper's chain renders, whose module the folded
    /// element must keep.
    fn anchor(&self, symbol: SymbolId, depth: usize) -> Option<SymbolId> {
        if self.imported.contains_key(&symbol) {
            return Some(symbol);
        }

        match self.candidates.get(&symbol)?.target {
            Target::Import(target) => Some(target),
            Target::Local(target) if depth < DEPTH => self.anchor(target, depth + 1),
            Target::Host(_) | Target::Local(_) => None,
        }
    }

    /// The fold of an imported wrapper.
    fn imported(&self, symbol: SymbolId) -> Option<&Fold> {
        let (specifier, name) = self.imported.get(&symbol)?;

        self.imports?.get(*specifier)?.get(*name)
    }

    /// The resolved fold of a wrapper's target binding.
    fn target(&self, symbol: SymbolId, folds: &FxHashMap<SymbolId, Option<Fold>>) -> Option<Fold> {
        if self.candidates.contains_key(&symbol) {
            return folds.get(&symbol).cloned().flatten();
        }

        self.imported(symbol).cloned()
    }
}

/// The fold of a wrapper whose element renders `target`. The target merges the wrapper's classes
/// after its own when it forwards `className`, and ignores them otherwise.
fn compose(target: &Fold, wrapper: &Candidate<'_>) -> Fold {
    if !target.forwards {
        return target.clone();
    }

    let mut classes = String::with_capacity(target.classes.len() + wrapper.classes.len() + 1);

    classes.push_str(&target.classes);
    classes.push(' ');
    classes.push_str(wrapper.classes);

    Fold {
        classes: Arc::from(classes),
        forwards: wrapper.forwards,
        tag: Arc::clone(&target.tag),
    }
}

/// The value imports of a module whose bindings name JSX elements, by specifier in source order,
/// with each declaration's span. Their modules may export wrappers the module folds.
pub fn imports<'a>(program: &'a Program<'a>, semantic: &Semantic<'a>) -> Vec<(&'a str, Span)> {
    let scoping = semantic.scoping();
    let nodes = semantic.nodes();
    let mut specifiers: Vec<(&'a str, Span)> = Vec::new();
    let mut seen: FxHashSet<&'a str> = FxHashSet::default();

    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };

        if import.import_kind != ImportOrExportKind::Value {
            continue;
        }

        let named = import.specifiers.iter().flatten().any(|specifier| {
            let local = match specifier {
                ImportDeclarationSpecifier::ImportSpecifier(specifier)
                    if specifier.import_kind == ImportOrExportKind::Value =>
                {
                    &specifier.local
                }
                ImportDeclarationSpecifier::ImportDefaultSpecifier(specifier) => &specifier.local,
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(_)
                | ImportDeclarationSpecifier::ImportSpecifier(_) => return false,
            };

            local.symbol_id.get().is_some_and(|symbol| {
                scoping
                    .get_resolved_reference_ids(symbol)
                    .iter()
                    .any(|reference| {
                        let node = scoping.get_reference(*reference).node_id();

                        matches!(nodes.parent_kind(node), AstKind::JSXOpeningElement(_))
                    })
            })
        });

        if named && seen.insert(import.source.value.as_str()) {
            specifiers.push((import.source.value.as_str(), import.span));
        }
    }

    specifiers
}
