//! Finds direct applications of local style definitions so the transform can fold or erase them.
//!
//! A candidate is a top-level `const` bound to a definition call, a top-level object of such
//! calls, or a non-exported namespace of `const` calls. Applications are no-argument calls of a
//! candidate or one of its exported members, or calls whose only argument overrides
//! `className`. Reads that escape keep the runtime callable.

use std::cell::OnceCell;
use std::sync::Arc;

use indexmap::IndexMap;
use oxc_ast::AstKind;
use oxc_ast::ast::{
    Argument, CallExpression, Declaration, Expression, JSXAttributeItem, JSXAttributeName,
    JSXElementName, ObjectExpression, ObjectPropertyKind, Program, PropertyKey, PropertyKind,
    Statement, TSNamespaceDeclarationBody, UnaryOperator, VariableDeclarationKind,
};
use oxc_semantic::Semantic;
use oxc_span::{GetSpan, Span};
use rustc_hash::{FxBuildHasher, FxHashMap, FxHashSet};

use crate::compiler::internal::expression::unwrap;
use crate::compiler::internal::scope::{self, Mode};
use crate::compiler::source::Call;

/// One application of a definition without arguments or with a `className` override alone.
#[derive(Clone, Debug, PartialEq)]
pub struct Application {
    /// End of the callee expression.
    pub callee_end: u32,
    /// The override value of a `{ className: value }` argument.
    pub class_override: Option<Override>,
    /// A plain read of the applied class list, as in `styles.card().className`.
    pub class_read: Option<ClassRead>,
    /// End of the call.
    pub end: u32,
    /// Whether every evaluation follows the definition's initialization.
    pub initialized: bool,
    /// Definition name.
    pub name: Arc<str>,
    /// The JSX spread attribute whose argument is the call, as in `<a {...styles.card()} />`.
    pub spread: Option<Span>,
    /// Start of the call.
    pub start: u32,
    /// Whether the application is the only class source of a DOM element.
    pub terminal: bool,
}

/// One application of a dynamic definition with an object literal, spread alone onto a DOM
/// element.
#[derive(Clone, Copy, Debug)]
pub struct Bound<'a> {
    /// End of the callee expression.
    pub callee_end: u32,
    /// End of the call.
    pub end: u32,
    /// Whether every evaluation follows the definition's initialization.
    pub initialized: bool,
    /// Start of the call.
    pub start: u32,
    /// The authored values.
    pub values: &'a ObjectExpression<'a>,
}

/// The value of an application's only argument property, `className`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Override {
    /// End of the value.
    pub end: u32,
    /// Whether the value is a read without calls or computed members, which can be repeated in
    /// an initialization guard without changing evaluation.
    pub simple: bool,
    /// Start of the value.
    pub start: u32,
}

/// A `.className` or `.class` read of an application's result, used only as a value.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ClassRead {
    /// End of the member expression.
    pub end: u32,
    /// Whether the read names `class`, the key of HTML output.
    pub html: bool,
}

/// A namespace whose members can be erased.
#[derive(Clone, Debug, PartialEq)]
pub struct Namespace {
    /// End of the namespace statement.
    pub end: u32,
    /// End of each member's binding, by definition name.
    pub ends: crate::js::Record<u32>,
    /// Start of the namespace statement.
    pub start: u32,
    /// Whether a type position names the namespace, so its member types must remain.
    pub typed: bool,
}

/// Definitions the transform may fold, and namespaces it may erase.
#[derive(Clone, Debug, Default)]
pub struct Definitions {
    /// Erasable namespaces.
    pub namespaces: Vec<Namespace>,
    /// Foldable definitions, with whether every application follows initialization.
    pub values: crate::js::Record<bool>,
}

/// Options for [`create`].
#[derive(Clone, Copy, Debug, Default)]
pub struct Options {
    /// Whether recipes, dynamic styles, and applications with arguments count as applications.
    pub dynamic: bool,
}

/// Definition calls by member name, in authored order.
type Members<'c, 'a> = IndexMap<Arc<str>, &'c Call<'a>, FxBuildHasher>;

struct Candidate<'c, 'a> {
    /// Span of the binding identifier.
    binding: Span,
    direct: Option<&'c Call<'a>>,
    /// Object or exported namespace members in authored order, by member name.
    members: Members<'c, 'a>,
    name: Arc<str>,
    namespace: Option<Namespace>,
    /// Non-exported namespace members, which only sibling definitions can read.
    private: Members<'c, 'a>,
    ready: u32,
}

/// What a lexical read is nested in.
#[derive(Clone, Copy)]
struct Read<'a> {
    /// The values object of a one-argument call spread alone onto a DOM element.
    bound: Option<&'a ObjectExpression<'a>>,
    deferred: bool,
    /// Parent of the identifier.
    parent: Option<AstKind<'a>>,
    /// Parent of the identifier's member expression, when the parent is one.
    grandparent: Option<AstKind<'a>>,
    /// The two ancestors above the grandparent, which hold an application's class read.
    outer: [Option<AstKind<'a>>; 2],
    /// Extraction resolves the read and rewrites its definition, so it never runs.
    resolved: bool,
    span: Span,
    terminal: bool,
}

/// The applications of one module's local definitions.
pub struct Applications<'c, 'a> {
    candidates: Vec<Candidate<'c, 'a>>,
    /// Each candidate's foldable applications and called definitions, read by several queries.
    collected: OnceCell<Vec<Collected>>,
    evaluation: bool,
    namespace_counts: FxHashMap<Arc<str>, usize>,
    referenced_definitions: FxHashSet<Arc<str>>,
    references: FxHashMap<Arc<str>, Vec<Read<'a>>>,
    options: Options,
}

/// One candidate's foldable applications and the definitions its reads call with arguments, or
/// `None` when a read cannot fold.
type Collected = Option<(Vec<Application>, FxHashSet<Arc<str>>)>;

fn is_call_of<'c, 'a>(
    definitions: &FxHashMap<u32, &'c Call<'a>>,
    node: &Expression<'a>,
) -> Option<&'c Call<'a>> {
    let Expression::CallExpression(call) = node else {
        return None;
    };
    let candidate = definitions.get(&call.span.start)?;

    (call.span.end == candidate.end).then_some(*candidate)
}

/// Collects candidates and their reads, or `None` when the module has no candidate.
pub fn create<'c, 'a>(
    program: &'a Program<'a>,
    semantic: &Semantic<'a>,
    calls: &'c [Call<'a>],
    options: Options,
) -> Option<Applications<'c, 'a>> {
    let definitions: FxHashMap<u32, &'c Call<'a>> =
        calls.iter().map(|call| (call.start, call)).collect();
    let mut member_bindings: FxHashMap<u32, Arc<str>> = FxHashMap::default();
    let mut namespace_counts: FxHashMap<Arc<str>, usize> = FxHashMap::default();

    for statement in &program.body {
        let declaration = match statement {
            Statement::ExportDeclaration(export) => Some(&export.declaration),
            other => other.as_declaration(),
        };
        let name = match declaration {
            Some(Declaration::TSNamespaceDeclaration(namespace)) => {
                Some(namespace.id.name.as_str())
            }
            Some(Declaration::TSGlobalDeclaration(_)) => Some("global"),
            _ => None,
        };

        if let Some(name) = name {
            *namespace_counts.entry(Arc::from(name)).or_default() += 1;
        }
    }

    let mut candidates: Vec<Candidate<'c, 'a>> = Vec::new();
    // Lookups find bindings by name, so only these names can read a candidate or a member.
    let mut names: FxHashSet<&'a str> = FxHashSet::default();

    for statement in &program.body {
        if let Statement::TSNamespaceDeclaration(namespace) = statement
            && let TSNamespaceDeclarationBody::TSModuleBlock(block) = &namespace.body
        {
            let mut members = Members::with_capacity_and_hasher(block.body.len(), FxBuildHasher);
            let mut private = Members::default();
            let mut ends = crate::js::Record::new();
            let mut bindings = Vec::with_capacity(block.body.len());
            let mut valid = true;

            names.reserve(block.body.len());

            'members: for member in &block.body {
                let (declaration, exported) = match member {
                    Statement::ExportDeclaration(export) => (Some(&export.declaration), true),
                    other => (other.as_declaration(), false),
                };
                let Some(Declaration::VariableDeclaration(variable)) = declaration else {
                    valid = false;
                    break;
                };

                if variable.kind != VariableDeclarationKind::Const {
                    valid = false;
                    break;
                }

                for declarator in &variable.declarations {
                    let oxc_ast::ast::BindingPattern::BindingIdentifier(identifier) =
                        &declarator.id
                    else {
                        valid = false;
                        break 'members;
                    };
                    let call = declarator
                        .init
                        .as_ref()
                        .and_then(|init| is_call_of(&definitions, init));
                    let Some(call) = call.filter(|_| {
                        !members.contains_key(identifier.name.as_str())
                            && !private.contains_key(identifier.name.as_str())
                    }) else {
                        valid = false;
                        break 'members;
                    };
                    // ESTree identifier ranges include their type annotation.
                    let end = declarator
                        .type_annotation
                        .as_ref()
                        .map_or(identifier.span.end, |annotation| annotation.span.end);

                    if exported {
                        members.insert(Arc::from(identifier.name.as_str()), call);
                    } else {
                        private.insert(Arc::from(identifier.name.as_str()), call);
                    }

                    ends.insert(Arc::clone(&call.name), end);
                    bindings.push((identifier.span.start, Arc::clone(&call.name)));
                    names.insert(identifier.name.as_str());
                }
            }

            for (start, name) in bindings {
                member_bindings.insert(start, name);
            }

            if valid && !members.is_empty() {
                names.insert(namespace.id.name.as_str());
                candidates.push(Candidate {
                    binding: namespace.id.span,
                    direct: None,
                    members,
                    name: Arc::from(namespace.id.name.as_str()),
                    namespace: Some(Namespace {
                        end: namespace.span.end,
                        ends,
                        start: namespace.span.start,
                        typed: false,
                    }),
                    private,
                    ready: namespace.span.end,
                });
            }

            continue;
        }

        // Exported values can escape and object members can subsequently be replaced.
        let Statement::VariableDeclaration(variable) = statement else {
            continue;
        };

        if variable.kind != VariableDeclarationKind::Const {
            continue;
        }

        for declarator in &variable.declarations {
            let (oxc_ast::ast::BindingPattern::BindingIdentifier(identifier), Some(init)) =
                (&declarator.id, &declarator.init)
            else {
                continue;
            };
            let direct = is_call_of(&definitions, init);
            let mut members = Members::default();

            if direct.is_none() {
                let Expression::ObjectExpression(object) = init else {
                    continue;
                };
                let mut valid = true;

                for property in &object.properties {
                    let ObjectPropertyKind::ObjectProperty(property) = property else {
                        valid = false;
                        break;
                    };

                    if property.computed || property.method || property.kind != PropertyKind::Init {
                        valid = false;
                        break;
                    }

                    let key = match &property.key {
                        PropertyKey::StaticIdentifier(key) => Some(key.name.as_str()),
                        _ => None,
                    };
                    let call = is_call_of(&definitions, &property.value);
                    let (Some(key), Some(call)) = (key, call) else {
                        valid = false;
                        break;
                    };

                    if key == "__proto__" || members.contains_key(key) {
                        valid = false;
                        break;
                    }

                    members.insert(Arc::from(key), call);
                }

                if !valid || members.is_empty() {
                    continue;
                }
            }

            names.insert(identifier.name.as_str());
            candidates.push(Candidate {
                binding: identifier.span,
                direct,
                members,
                name: Arc::from(identifier.name.as_str()),
                namespace: None,
                private: Members::default(),
                ready: declarator.span.end,
            });
        }
    }

    if candidates.is_empty() {
        return None;
    }

    let mut walker = Walker {
        ancestors: Vec::new(),
        candidates: candidates
            .iter()
            .map(|candidate| (candidate.binding.start, Arc::clone(&candidate.name)))
            .collect(),
        definitions: &definitions,
        evaluation: false,
        member_bindings: &member_bindings,
        names,
        referenced_definitions: FxHashSet::default(),
        // A namespace's members are usually each read once.
        references: candidates
            .iter()
            .map(|candidate| {
                (
                    Arc::clone(&candidate.name),
                    Vec::with_capacity(candidate.members.len()),
                )
            })
            .collect(),
        semantic,
        typed: FxHashSet::default(),
    };

    walker.scan();

    for candidate in &mut candidates {
        if let Some(namespace) = &mut candidate.namespace {
            namespace.typed = walker.typed.contains(&*candidate.name);
        }
    }

    Some(Applications {
        candidates,
        collected: OnceCell::new(),
        evaluation: walker.evaluation,
        namespace_counts,
        referenced_definitions: walker.referenced_definitions,
        references: walker.references,
        options,
    })
}

struct Walker<'s, 'a> {
    ancestors: Vec<AstKind<'a>>,
    candidates: FxHashMap<u32, Arc<str>>,
    /// Definition calls by start offset.
    definitions: &'s FxHashMap<u32, &'s Call<'a>>,
    evaluation: bool,
    member_bindings: &'s FxHashMap<u32, Arc<str>>,
    /// Names of candidates and namespace members.
    names: FxHashSet<&'a str>,
    referenced_definitions: FxHashSet<Arc<str>>,
    references: FxHashMap<Arc<str>, Vec<Read<'a>>>,
    semantic: &'s Semantic<'a>,
    /// Names read outside value positions, such as in `typeof styles.card`.
    typed: FxHashSet<&'a str>,
}

/// Whether evaluation of a node's contents waits for a later call or declaration.
fn defers(kind: &AstKind<'_>) -> bool {
    matches!(
        kind,
        AstKind::ArrowFunctionExpression(_)
            | AstKind::Class(_)
            | AstKind::Function(_)
            | AstKind::TSNamespaceDeclaration(_)
            | AstKind::TSGlobalDeclaration(_)
            | AstKind::TSExternalModuleDeclaration(_)
    )
}

const TYPE_CONTEXTS: [fn(&AstKind<'_>) -> bool; 6] = [
    |kind| matches!(kind, AstKind::TSTypeQuery(_)),
    |kind| matches!(kind, AstKind::TSTypeAnnotation(_)),
    |kind| matches!(kind, AstKind::TSTypeAliasDeclaration(_)),
    |kind| matches!(kind, AstKind::TSInterfaceDeclaration(_)),
    |kind| matches!(kind, AstKind::TSTypeParameterInstantiation(_)),
    |kind| matches!(kind, AstKind::TSTypeParameterDeclaration(_)),
];

impl Walker<'_, '_> {
    /// Reads identifiers in entry order from the semantic node list. Parents come from its links,
    /// and a candidate read alone rebuilds its full ancestor path.
    fn scan(&mut self) {
        let semantic = self.semantic;
        let nodes = semantic.nodes();

        // An identifier spells `eval` literally or with an escape, so other sources skip the check.
        let source = semantic.source_text().as_bytes();
        let spelled = memchr::memmem::find(source, b"eval").is_some()
            || memchr::memmem::find(source, b"\\u").is_some();

        for node in nodes.iter() {
            let kind = node.kind();

            if spelled {
                let name = match kind {
                    AstKind::IdentifierReference(identifier) => Some(identifier.name.as_str()),
                    AstKind::BindingIdentifier(identifier) => Some(identifier.name.as_str()),
                    AstKind::IdentifierName(identifier) => Some(identifier.name.as_str()),
                    AstKind::LabelIdentifier(identifier) => Some(identifier.name.as_str()),
                    _ => None,
                };

                if name == Some("eval") {
                    self.evaluation = true;
                }
            }

            let AstKind::IdentifierReference(identifier) = kind else {
                continue;
            };

            if !self.names.contains(identifier.name.as_str()) {
                continue;
            }

            let id = node.id();
            let parent = (nodes.parent_id(id) != id).then(|| nodes.parent_kind(id));

            if parent.is_some_and(|parent| !scope::is_value_reference(parent))
                || nodes
                    .ancestor_kinds(id)
                    .any(|ancestor| TYPE_CONTEXTS.iter().any(|test| test(&ancestor)))
            {
                self.typed.insert(identifier.name.as_str());
                continue;
            }

            let scope = scope::scope_of(semantic, kind.node_id());
            let Some(binding) = scope::lookup(semantic, &identifier.name, scope, Mode::Value)
            else {
                continue;
            };
            // ScopeTracker reports the binding identifier for variables and namespaces.
            let declared = semantic.scoping().symbol_span(binding.symbol);

            if let Some(member) = self.member_bindings.get(&declared.start) {
                self.referenced_definitions.insert(Arc::clone(member));
            }

            let Some(name) = self.candidates.get(&declared.start) else {
                continue;
            };

            // Only reads whose name still names the candidate bind its applications.
            if *identifier.name != **name {
                continue;
            }

            self.ancestors.clear();
            self.ancestors.extend(nodes.ancestor_kinds(id));
            self.ancestors.reverse();
            self.ancestors.push(kind);

            let count = self.ancestors.len();
            let read = Read {
                bound: bound(&self.ancestors),
                deferred: self.ancestors.iter().any(defers),
                grandparent: count
                    .checked_sub(3)
                    .and_then(|index| self.ancestors.get(index))
                    .copied(),
                outer: [4, 5].map(|depth| {
                    count
                        .checked_sub(depth)
                        .and_then(|index| self.ancestors.get(index))
                        .copied()
                }),
                parent,
                resolved: extracted(&self.ancestors, self.definitions),
                span: identifier.span,
                terminal: terminal(&self.ancestors),
            };

            if let Some(reads) = self.references.get_mut(name) {
                reads.push(read);
            }
        }
    }
}

/// The `.className` or `.class` member of a call, when its parent only reads its value.
fn class_read(call: Span, [member, parent]: [Option<AstKind<'_>>; 2]) -> Option<ClassRead> {
    let Some(AstKind::StaticMemberExpression(member)) = member else {
        return None;
    };

    if member.optional || member.object.span() != call {
        return None;
    }

    let html = match member.property.name.as_str() {
        "class" => true,
        "className" => false,
        _ => return None,
    };
    let span = member.span;
    // Writes, calls, deletions, and grouped expressions keep the object.
    let value = match parent? {
        AstKind::ArrayExpression(_)
        | AstKind::AwaitExpression(_)
        | AstKind::BinaryExpression(_)
        | AstKind::ConditionalExpression(_)
        | AstKind::ExportDefaultDeclaration(_)
        | AstKind::ExpressionStatement(_)
        | AstKind::JSXExpressionContainer(_)
        | AstKind::LogicalExpression(_)
        | AstKind::ReturnStatement(_)
        | AstKind::SequenceExpression(_)
        | AstKind::SpreadElement(_)
        | AstKind::TemplateLiteral(_)
        | AstKind::TSAsExpression(_)
        | AstKind::TSSatisfiesExpression(_) => true,
        AstKind::AssignmentExpression(assignment) => assignment.right.span() == span,
        AstKind::CallExpression(call) => call.callee.span() != span,
        AstKind::NewExpression(call) => call.callee.span() != span,
        AstKind::ObjectProperty(property) => !property.computed && property.value.span() == span,
        AstKind::UnaryExpression(unary) => unary.operator != UnaryOperator::Delete,
        AstKind::VariableDeclarator(declarator) => {
            declarator.init.as_ref().map(GetSpan::span) == Some(span)
        }
        _ => false,
    };

    value.then_some(ClassRead {
        end: span.end,
        html,
    })
}

/// A static member read `object.name` of a reference.
fn member_name(kind: Option<AstKind<'_>>, object: Span) -> Option<(&str, Span)> {
    match kind? {
        AstKind::StaticMemberExpression(member)
            if !member.optional && member.object.span() == object =>
        {
            Some((member.property.name.as_str(), member.span))
        }
        _ => None,
    }
}

/// Whether a parent is a non-optional call of a callee.
fn call_of<'k, 'a>(kind: Option<AstKind<'a>>, callee: Span) -> Option<&'k CallExpression<'a>>
where
    'a: 'k,
{
    match kind? {
        AstKind::CallExpression(call) if !call.optional && call.callee.span() == callee => {
            Some(call)
        }
        _ => None,
    }
}

/// The value of a call's only argument when that argument is `{ className: value }`.
fn class_override(call: &CallExpression<'_>) -> Option<Override> {
    let [argument] = call.arguments.as_slice() else {
        return None;
    };
    let Some(Expression::ObjectExpression(object)) = argument.as_expression() else {
        return None;
    };
    let [ObjectPropertyKind::ObjectProperty(property)] = object.properties.as_slice() else {
        return None;
    };

    if property.computed || property.method || property.kind != PropertyKind::Init {
        return None;
    }

    let named = match &property.key {
        PropertyKey::StaticIdentifier(key) => key.name == "className",
        PropertyKey::StringLiteral(key) => key.value == "className",
        _ => false,
    };
    let span = property.value.span();

    named.then(|| Override {
        end: span.end,
        simple: simple(&property.value),
        start: span.start,
    })
}

/// Matches identifiers and static member chains of them, whose reads call no function.
fn simple(expression: &Expression<'_>) -> bool {
    match expression {
        Expression::Identifier(_) => true,
        Expression::StaticMemberExpression(member) => !member.optional && simple(&member.object),
        _ => false,
    }
}

/// The JSX spread attribute whose argument is exactly a call.
fn spread_of(kind: Option<AstKind<'_>>, call: Span) -> Option<Span> {
    match kind? {
        AstKind::JSXSpreadAttribute(spread) if spread.argument.span() == call => Some(spread.span),
        _ => None,
    }
}

impl<'c, 'a> Applications<'c, 'a> {
    /// Every candidate's collected applications, in candidate order.
    fn collected(&self) -> &[Collected] {
        self.collected.get_or_init(|| {
            self.candidates
                .iter()
                .map(|candidate| self.collect(candidate))
                .collect()
        })
    }

    fn collect(&self, candidate: &Candidate<'c, 'a>) -> Collected {
        let mut applications = Vec::new();
        let mut called = FxHashSet::default();

        for reference in self
            .references
            .get(&candidate.name)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            if reference.span == candidate.binding || reference.resolved {
                continue;
            }

            let [above, outermost] = reference.outer;
            let (call, callee, application, read) = if let Some(direct) = candidate.direct {
                (
                    Some(direct),
                    reference.span,
                    reference.parent,
                    [reference.grandparent, above],
                )
            } else {
                let (name, member) = member_name(reference.parent, reference.span)?;

                (
                    candidate.members.get(name).copied(),
                    member,
                    reference.grandparent,
                    [above, outermost],
                )
            };

            if call.is_some_and(|call| {
                call.composition.is_some()
                    || call.runtime_composition.is_some()
                    || (!self.options.dynamic && (call.slots.is_some() || call.recipe.is_some()))
            }) {
                continue;
            }

            let call = call?;
            let node = call_of(application, callee)?;
            let span = node.span;
            let class_override = if self.options.dynamic || node.arguments.is_empty() {
                None
            } else if let Some(value) = class_override(node) {
                Some(value)
            } else {
                // Other overrides need the runtime callable, but expose no other definition.
                called.insert(Arc::clone(&call.name));
                continue;
            };

            applications.push(Application {
                callee_end: callee.end,
                class_override,
                class_read: class_read(span, read),
                end: span.end,
                initialized: !reference.deferred
                    && reference.span.start >= candidate.ready
                    && (candidate.namespace.is_none()
                        || self.namespace_counts.get(&candidate.name) == Some(&1)),
                name: Arc::clone(&call.name),
                spread: spread_of(read[0], span),
                start: span.start,
                terminal: reference.terminal,
            });
        }

        Some((applications, called))
    }

    fn unique(&self) -> FxHashMap<&Arc<str>, usize> {
        let mut counts: FxHashMap<&Arc<str>, usize> = FxHashMap::default();

        for candidate in &self.candidates {
            *counts.entry(&candidate.name).or_default() += 1;
        }

        counts
    }

    /// Definitions that no read can apply, whose rules can be dropped.
    pub fn dead(&self) -> FxHashSet<Arc<str>> {
        let mut result = FxHashSet::default();

        if self.evaluation {
            return result;
        }

        let counts = self.unique();

        for candidate in &self.candidates {
            if counts.get(&candidate.name).copied().unwrap_or_default() > 1
                || self
                    .namespace_counts
                    .get(&candidate.name)
                    .copied()
                    .unwrap_or_default()
                    > 1
            {
                continue;
            }

            let reads = self
                .references
                .get(&candidate.name)
                .map(Vec::as_slice)
                .unwrap_or_default();

            if let Some(direct) = candidate.direct {
                if reads.is_empty() {
                    result.insert(Arc::clone(&direct.name));
                }
                continue;
            }

            let mut used: FxHashSet<&str> = FxHashSet::default();
            let mut escapes = false;

            for reference in reads {
                if let Some((name, _)) = member_name(reference.parent, reference.span) {
                    used.insert(name);
                } else {
                    escapes = true;
                    break;
                }
            }

            if !escapes {
                for (name, call) in &candidate.members {
                    if !used.contains(&**name) && !self.referenced_definitions.contains(&call.name)
                    {
                        result.insert(Arc::clone(&call.name));
                    }
                }
            }

            for call in candidate.private.values() {
                if !self.referenced_definitions.contains(&call.name) {
                    result.insert(Arc::clone(&call.name));
                }
            }
        }

        result
    }

    /// Definitions whose every read is a foldable application.
    pub fn definitions(&self) -> Definitions {
        let mut output = Definitions::default();

        if self.evaluation {
            return output;
        }

        let counts = self.unique();

        for (candidate, collected) in self.candidates.iter().zip(self.collected()) {
            if counts.get(&candidate.name).copied().unwrap_or_default() > 1
                || self
                    .namespace_counts
                    .get(&candidate.name)
                    .copied()
                    .unwrap_or_default()
                    > 1
            {
                continue;
            }

            let Some((applications, called)) = collected else {
                continue;
            };
            let mut erased = candidate.namespace.is_some();
            let uninitialized: FxHashSet<&str> = applications
                .iter()
                .filter(|application| !application.initialized)
                .map(|application| &*application.name)
                .collect();
            let calls: Vec<&Call<'a>> = match candidate.direct {
                Some(direct) => vec![direct],
                None => candidate
                    .members
                    .values()
                    .chain(candidate.private.values())
                    .copied()
                    .collect(),
            };

            for call in calls {
                if call.composition.is_some()
                    || call.runtime_composition.is_some()
                    || call.slots.is_some()
                    || call.recipe.is_some()
                    || called.contains(&call.name)
                {
                    erased = false;
                    continue;
                }

                let initialized = !uninitialized.contains(&*call.name);

                output.values.insert(Arc::clone(&call.name), initialized);
                erased &= initialized;
            }

            if erased && let Some(namespace) = &candidate.namespace {
                output.namespaces.push(namespace.clone());
            }
        }

        output
    }

    /// Applications of each dynamic definition that bind an object literal on a DOM element alone,
    /// by definition name, in candidate order.
    pub fn bound(&self) -> FxHashMap<Arc<str>, Vec<Bound<'a>>> {
        let mut output: FxHashMap<Arc<str>, Vec<Bound<'a>>> = FxHashMap::default();

        if self.evaluation {
            return output;
        }

        // Merged namespace declarations share one read list, so each name's reads are walked once.
        let mut groups: IndexMap<&Arc<str>, Vec<&Candidate<'c, 'a>>, FxBuildHasher> =
            IndexMap::default();

        for candidate in &self.candidates {
            groups.entry(&candidate.name).or_default().push(candidate);
        }

        for (name, candidates) in groups {
            let reads = self
                .references
                .get(name)
                .map(Vec::as_slice)
                .unwrap_or_default();
            let bindings: FxHashSet<u32> = candidates
                .iter()
                .map(|candidate| candidate.binding.start)
                .collect();
            let direct = match candidates.as_slice() {
                [candidate] => candidate.direct.map(|call| (*candidate, call)),
                _ => None,
            };

            // Any member read other than a call could replace the member, as `styles.dot = other` does.
            if direct.is_none()
                && !reads.iter().all(|reference| {
                    bindings.contains(&reference.span.start)
                        || reference.resolved
                        || member_name(reference.parent, reference.span).is_some_and(
                            |(_, member)| call_of(reference.grandparent, member).is_some(),
                        )
                })
            {
                continue;
            }

            // A member declared by two merged declarations has no single definition.
            let mut members: FxHashMap<&str, Option<(&Candidate<'c, 'a>, &'c Call<'a>)>> =
                FxHashMap::default();

            if direct.is_none() {
                for candidate in &candidates {
                    for (member, call) in &candidate.members {
                        members
                            .entry(&**member)
                            .and_modify(|entry| *entry = None)
                            .or_insert(Some((*candidate, *call)));
                    }
                }
            }

            for reference in reads {
                let Some(values) = reference.bound else {
                    continue;
                };

                if bindings.contains(&reference.span.start) || reference.resolved {
                    continue;
                }

                let (candidate, call, callee, application) = if let Some((candidate, call)) = direct
                {
                    (candidate, call, reference.span, reference.parent)
                } else {
                    let Some((member, span)) = member_name(reference.parent, reference.span) else {
                        continue;
                    };
                    let Some(Some((candidate, call))) = members.get(member).copied() else {
                        continue;
                    };

                    (candidate, call, span, reference.grandparent)
                };

                if call.slots.is_none()
                    || call.recipe.is_some()
                    || call.composition.is_some()
                    || call.runtime_composition.is_some()
                {
                    continue;
                }

                let Some(span) = call_of(application, callee)
                    .filter(|call| call.arguments.len() == 1)
                    .map(|call| call.span)
                else {
                    continue;
                };

                // A merged namespace can exist before a member's declaration, so the guard's bare
                // call would skip evaluating the authored values before it throws.
                if candidate.namespace.is_some() && self.namespace_counts.get(name) != Some(&1) {
                    continue;
                }

                output
                    .entry(Arc::clone(&call.name))
                    .or_default()
                    .push(Bound {
                        callee_end: callee.end,
                        end: span.end,
                        initialized: !reference.deferred && reference.span.start >= candidate.ready,
                        start: span.start,
                        values,
                    });
            }
        }

        output
    }

    /// Every foldable application, in candidate order.
    pub fn find(&self) -> impl Iterator<Item = &Application> {
        let collected = if self.evaluation {
            &[]
        } else {
            self.collected()
        };

        collected
            .iter()
            .flatten()
            .flat_map(|(applications, _)| applications)
    }
}

// Matches a selector interpolation or composition entry inside a definition, which
// extraction resolves statically. Computed keys elsewhere in a definition fail extraction.
fn extracted(path: &[AstKind<'_>], definitions: &FxHashMap<u32, &Call<'_>>) -> bool {
    let Some(mut index) = path.len().checked_sub(1) else {
        return false;
    };

    if let (Some(AstKind::StaticMemberExpression(member)), Some(node)) = (
        index.checked_sub(1).and_then(|at| path.get(at)),
        path.get(index),
    ) && member.object.span() == node.span()
    {
        index -= 1;
    }

    // Type assertions around a node keep the same read.
    let mut parent = || {
        while index > 0
            && path.get(index - 1).is_some_and(|kind| {
                matches!(
                    kind,
                    AstKind::TSAsExpression(_)
                        | AstKind::TSNonNullExpression(_)
                        | AstKind::TSSatisfiesExpression(_)
                        | AstKind::TSTypeAssertion(_)
                )
            })
        {
            index -= 1;
        }

        index = index.checked_sub(1)?;
        path.get(index).copied()
    };
    let definition = |kind: &AstKind<'_>| {
        matches!(kind, AstKind::CallExpression(call)
            if definitions.get(&call.span.start).is_some_and(|definition| definition.end == call.span.end))
    };

    match parent() {
        Some(AstKind::ArrayExpression(container)) => parent().is_some_and(|kind| {
            definition(&kind)
                && matches!(kind, AstKind::CallExpression(call)
                    if call.arguments.first().and_then(Argument::as_expression)
                        .is_some_and(|argument| unwrap(argument).span() == container.span))
        }),
        Some(AstKind::TemplateLiteral(container)) => {
            let property = parent();

            matches!(property, Some(AstKind::ObjectProperty(property))
                if property.computed
                    && property.key.as_expression().is_some_and(|key| unwrap(key).span() == container.span))
                && path
                    .get(..index)
                    .is_some_and(|ancestors| ancestors.iter().any(definition))
        }
        _ => false,
    }
}

/// Matches a no-argument application spread onto, or read as the class of, a DOM element.
fn terminal(path: &[AstKind<'_>]) -> bool {
    let Some(mut index) = path.len().checked_sub(1) else {
        return false;
    };
    let mut node = path.get(index).map(GetSpan::span);

    if let (Some(AstKind::StaticMemberExpression(member)), Some(span)) =
        (index.checked_sub(1).and_then(|at| path.get(at)), node)
        && member.object.span() == span
    {
        index -= 1;
        node = Some(member.span);
    }

    let Some(call_index) = index.checked_sub(1) else {
        return false;
    };
    let Some(AstKind::CallExpression(call)) = path.get(call_index) else {
        return false;
    };

    if Some(call.callee.span()) != node || !call.arguments.is_empty() {
        return false;
    }

    let parent_index = call_index.wrapping_sub(1);

    match path.get(parent_index) {
        Some(AstKind::JSXSpreadAttribute(spread)) => {
            spread.argument.span() == call.span
                && alone(
                    parent_index.checked_sub(1).and_then(|at| path.get(at)),
                    spread.span,
                )
        }
        Some(AstKind::StaticMemberExpression(member))
            if member.object.span() == call.span
                && is_class_name(member.property.name.as_str()) =>
        {
            let container_index = parent_index.wrapping_sub(1);
            let Some(AstKind::JSXExpressionContainer(container)) = path.get(container_index) else {
                return false;
            };

            if container.expression.span() != member.span {
                return false;
            }

            let attribute_index = container_index.wrapping_sub(1);
            let Some(AstKind::JSXAttribute(attribute)) = path.get(attribute_index) else {
                return false;
            };
            let JSXAttributeName::Identifier(name) = &attribute.name else {
                return false;
            };

            attribute
                .value
                .as_ref()
                .is_some_and(|value| value.span() == container.span)
                && is_class_name(name.name.as_str())
                && alone(
                    attribute_index.checked_sub(1).and_then(|at| path.get(at)),
                    attribute.span,
                )
        }
        _ => false,
    }
}

/// The object literal of a one-argument application spread alone onto a DOM element.
fn bound<'a>(path: &[AstKind<'a>]) -> Option<&'a ObjectExpression<'a>> {
    let mut index = path.len().checked_sub(1)?;
    let mut node = path.get(index)?.span();

    if let Some(AstKind::StaticMemberExpression(member)) =
        index.checked_sub(1).and_then(|at| path.get(at))
        && member.object.span() == node
    {
        index -= 1;
        node = member.span;
    }

    let call_index = index.checked_sub(1)?;
    let AstKind::CallExpression(call) = *path.get(call_index)? else {
        return None;
    };
    let [Argument::ObjectExpression(values)] = call.arguments.as_slice() else {
        return None;
    };

    if call.optional || call.callee.span() != node {
        return None;
    }

    let spread_index = call_index.checked_sub(1)?;
    let AstKind::JSXSpreadAttribute(spread) = *path.get(spread_index)? else {
        return None;
    };

    (spread.argument.span() == call.span
        && alone(
            spread_index.checked_sub(1).and_then(|at| path.get(at)),
            spread.span,
        ))
    .then_some(&**values)
}

/// Matches `^class(?:Name)?$`.
fn is_class_name(name: &str) -> bool {
    name == "class" || name == "className"
}

// Other spreads or class attributes could add another style's classes.
fn alone(element: Option<&AstKind<'_>>, own: Span) -> bool {
    let Some(AstKind::JSXOpeningElement(element)) = element else {
        return false;
    };
    let name = match &element.name {
        JSXElementName::Identifier(identifier) => identifier.name.as_str(),
        JSXElementName::IdentifierReference(identifier) => identifier.name.as_str(),
        _ => return false,
    };

    name.starts_with(|character: char| character.is_ascii_lowercase())
        && element.attributes.iter().all(|attribute| {
            attribute.span() == own
                || matches!(attribute, JSXAttributeItem::Attribute(attribute) if !match &attribute.name {
                    JSXAttributeName::Identifier(identifier) => identifier.name.as_str(),
                    JSXAttributeName::NamespacedName(name) => name.namespace.name.as_str(),
                }.starts_with("class"))
        })
}
