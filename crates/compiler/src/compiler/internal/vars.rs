//! Resolves individual CSS variables across lexical scopes and packed libraries.
//!
//! [`collect`] reads `variable()` declarations, their object groups and namespaces, and imported
//! variable links. The extraction walk passes each identifier read to [`Variables::reference`].

use std::borrow::Cow;
use std::sync::Arc;

use indexmap::IndexMap;
use oxc_allocator::{Address, GetAddress};
use oxc_ast::AstKind;
use oxc_ast::ast::{
    self, BindingPattern, CallExpression, Expression, ImportDeclarationSpecifier, ModuleExportName,
    ObjectPropertyKind, PropertyKey, PropertyKind, Statement, TSNamespaceDeclaration,
    TSNamespaceDeclarationBody, UnaryOperator, VariableDeclarationKind,
};
use oxc_ast_visit::Visit;
use oxc_span::{GetSpan, Span};
use rustc_hash::{FxBuildHasher, FxHashMap, FxHashSet};

use crate::compiler::internal::scope::{self, Declaration, Kind, Mode};
use crate::compiler::internal::syntax::Parsed;
use crate::compiler::internal::themes::{Call as LinkCall, Link, LinkKind, estree_ancestors};
use crate::compiler::internal::{expression, statics};
use crate::data::{Data, Object};
use crate::error::{Error, Result};
use crate::internal::binding::{self, Domain};
use crate::internal::identity;
use crate::internal::theme::{self, Definition};
use crate::js::{self, Record};
use crate::web::internal::contributions::{self, Scalar};

/// One `variable()` call replaced with immutable compiler-assigned slot data.
#[derive(Clone, Debug, PartialEq)]
pub struct Call {
    /// Exclusive offset.
    pub end: u32,
    /// Whether the consumer supplied a portable variable identity.
    pub explicit: bool,
    /// The fixed scalar slot, under `value`.
    pub slots: Record<Arc<binding::Reference>>,
    /// Inclusive offset.
    pub start: u32,
}

/// A variable read, by the start of the read.
#[derive(Clone, Debug)]
pub struct VariableRead {
    /// Exclusive offset of the read.
    pub end: u32,
    /// The slot the read names.
    pub reference: Arc<binding::Reference>,
}

/// Module-owned variables and the reads that name them.
///
/// Offsets are UTF-8 offsets into the module source.
pub struct Variables<'a> {
    /// `variable()` calls in walk order.
    pub calls: Vec<Call>,
    /// Exported variables and groups, by exported name.
    pub exports: Record<Link>,
    /// Variable reads, by start: identifiers, including property keys that name a variable, and
    /// member reads of groups.
    pub references: IndexMap<u32, VariableRead, FxBuildHasher>,
    /// Calls of registered variables, in registration order.
    pub registration_locations: Vec<Span>,
    /// `property` stylesheet contributions of registered variables, in walk order.
    pub registrations: Vec<contributions::Definition>,
    /// Starts of registered calls, in registration order.
    pub registration_starts: Vec<u32>,
    resolver: Resolver<'a>,
}

/// The lexical data reads resolve through.
struct Resolver<'a> {
    bindings: FxHashMap<u32, &'a Expression<'a>>,
    declarations: FxHashMap<u32, u32>,
    definitions: FxHashMap<u32, Link>,
    external: FxHashMap<u32, Link>,
    imports: FxHashSet<u32>,
    namespace: Arc<str>,
    namespaces: FxHashMap<u32, Vec<(Arc<str>, &'a Expression<'a>)>>,
    utf16: js::Utf16Index,
}

#[cold]
fn fail<T>(message: &str, span: Span) -> Result<T> {
    Err(Error::Themes {
        message: message.to_owned(),
        span,
    })
}

fn export_name<'b>(name: &'b ModuleExportName<'_>) -> &'b str {
    match name {
        ModuleExportName::IdentifierName(identifier) => &identifier.name,
        ModuleExportName::IdentifierReference(identifier) => &identifier.name,
        ModuleExportName::StringLiteral(literal) => &literal.value,
    }
}

/// Whether a namespace is part of a dotted declaration, which ESTree names with a qualified name.
fn dotted(namespace: &TSNamespaceDeclaration<'_>, parent: Option<AstKind<'_>>) -> bool {
    matches!(
        namespace.body,
        TSNamespaceDeclarationBody::TSNamespaceDeclaration(_)
    ) || matches!(parent, Some(AstKind::TSNamespaceDeclaration(_)))
}

/// Exported `const` members of a namespace block.
fn members<'a>(namespace: &'a TSNamespaceDeclaration<'a>) -> Vec<(Arc<str>, &'a Expression<'a>)> {
    let TSNamespaceDeclarationBody::TSModuleBlock(block) = &namespace.body else {
        return Vec::new();
    };
    let mut result: Vec<(Arc<str>, &'a Expression<'a>)> = Vec::new();

    for statement in &block.body {
        let Statement::ExportDeclaration(export) = statement else {
            continue;
        };
        let ast::Declaration::VariableDeclaration(declaration) = &export.declaration else {
            continue;
        };

        if declaration.kind != VariableDeclarationKind::Const {
            continue;
        }

        for declarator in &declaration.declarations {
            if let (BindingPattern::BindingIdentifier(id), Some(init)) =
                (&declarator.id, &declarator.init)
            {
                let name = Arc::from(id.name.as_str());

                match result.iter_mut().find(|(key, _)| *key == name) {
                    Some(entry) => entry.1 = init,
                    None => result.push((name, init)),
                }
            }
        }
    }

    result
}

/// The start and name of an ESTree `Identifier`: identifier references outside JSX names,
/// binding identifiers, identifier names, and labels.
fn identifier<'a>(kind: AstKind<'a>, parent: Option<AstKind<'_>>) -> Option<(Span, &'a str)> {
    match kind {
        AstKind::IdentifierReference(identifier) => {
            (!jsx(parent)).then_some((identifier.span, identifier.name.as_str()))
        }
        AstKind::BindingIdentifier(identifier) => Some((identifier.span, identifier.name.as_str())),
        AstKind::IdentifierName(identifier) => Some((identifier.span, identifier.name.as_str())),
        AstKind::LabelIdentifier(identifier) => Some((identifier.span, identifier.name.as_str())),
        _ => None,
    }
}

/// Whether an identifier reference is a JSX element name, which ESTree spells `JSXIdentifier`.
fn jsx(parent: Option<AstKind<'_>>) -> bool {
    matches!(
        parent,
        Some(
            AstKind::JSXOpeningElement(_)
                | AstKind::JSXClosingElement(_)
                | AstKind::JSXMemberExpression(_)
        )
    )
}

/// Whether an identifier reference is a value reference, as oxc-walker classifies it.
fn value_reference(parent: Option<AstKind<'_>>) -> bool {
    !matches!(
        parent,
        Some(
            AstKind::TSTypeReference(_)
                | AstKind::TSQualifiedName(_)
                | AstKind::TSClassImplements(_)
                | AstKind::TSInterfaceHeritage(_)
        )
    )
}

/// Collects module-owned declarations without executing application code.
///
/// `links` holds imported variable links by local name. `module_id` names the canonical owner of
/// variable reads.
///
/// # Errors
///
/// Returns `Source.ThemeInvalidError` for unsupported `variable()` calls and registrations, and a
/// plain error for an explicit id that is not a nonempty string.
pub fn collect<'a>(
    parsed: &Parsed<'a>,
    namespace: &str,
    links: &Record<Link>,
    module_id: &str,
) -> Result<Variables<'a>> {
    let program = parsed.program;
    let mut imports = FxHashSet::default();
    let mut external = FxHashMap::default();

    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };

        if import.import_kind.is_type() {
            continue;
        }

        for specifier in import.specifiers.iter().flatten() {
            if let ImportDeclarationSpecifier::ImportSpecifier(named) = specifier
                && named.import_kind.is_type()
            {
                continue;
            }

            let start = specifier.span().start;

            if let Some(link) = links.get(specifier.local().name.as_str())
                && link.kind == LinkKind::Variables
            {
                external.insert(start, link.clone());
            }

            if import.source.value == "zyzz"
                && let ImportDeclarationSpecifier::ImportSpecifier(named) = specifier
                && export_name(&named.imported) == "variable"
            {
                imports.insert(start);
            }
        }
    }

    let mut resolver = Resolver {
        bindings: FxHashMap::default(),
        declarations: FxHashMap::default(),
        definitions: FxHashMap::default(),
        external,
        imports,
        namespace: Arc::from(namespace),
        namespaces: FxHashMap::default(),
        utf16: parsed.offsets.clone(),
    };
    let empty = Variables {
        calls: Vec::new(),
        exports: Record::new(),
        references: IndexMap::default(),
        registration_locations: Vec::new(),
        registrations: Vec::new(),
        registration_starts: Vec::new(),
        resolver: Resolver {
            bindings: FxHashMap::default(),
            declarations: FxHashMap::default(),
            definitions: FxHashMap::default(),
            external: FxHashMap::default(),
            imports: FxHashSet::default(),
            namespace: Arc::from(namespace),
            namespaces: FxHashMap::default(),
            utf16: js::Utf16Index::default(),
        },
    };

    if resolver.imports.is_empty() && resolver.external.is_empty() {
        return Ok(empty);
    }

    let authored = parsed.names();
    let mut scan = Scan {
        ancestors: Vec::new(),
        error: None,
        factories: Vec::new(),
        parsed,
        resolver: &mut resolver,
        undefined: FxHashSet::default(),
    };

    scan.visit_program(program);

    if let Some(error) = scan.error {
        return Err(error);
    }

    let Scan {
        factories,
        undefined,
        ..
    } = scan;
    let mut calls = Vec::new();
    let mut registrations = Vec::new();
    let mut registration_starts = Vec::new();
    let mut registration_locations = Vec::new();

    for call in factories {
        let arguments = &call.arguments;
        let domain = arguments
            .first()
            .map(|argument| argument.as_expression().map(expression::unwrap));
        let object = |expression: Option<&'a Expression<'a>>| match expression {
            Some(Expression::ObjectExpression(object)) => Some(&**object),
            _ => None,
        };
        let grouped = object(domain.flatten());
        // A spread argument is no expression, so it is never a registration object.
        let value = match grouped {
            Some(object) => Some(Some(object)),
            None => arguments
                .get(1)
                .map(|argument| object(argument.as_expression().map(expression::unwrap))),
        };
        let kind: Option<String> = if arguments.is_empty() || grouped.is_some() {
            Some("*".to_owned())
        } else {
            match domain.flatten() {
                Some(literal) if statics::is_literal(literal) => literal_value(literal),
                _ => None,
            }
        };
        let domain = kind.as_deref().and_then(Domain::parse);
        let (Some(domain), Some(Some(_)) | None) = (domain, value) else {
            return fail(
                "variable requires a scalar domain and optional literal registration options.",
                call.span,
            );
        };

        if arguments.len() > 2 {
            return fail(
                "variable requires a scalar domain and optional literal registration options.",
                call.span,
            );
        }

        let registration = value.flatten();
        let mut descriptor: Vec<(String, Data)> = Vec::new();

        if let Some(value) = registration {
            for entry in &value.properties {
                let ObjectPropertyKind::ObjectProperty(entry) = entry else {
                    return fail(
                        "Variable registrations require literal descriptors.",
                        value.span,
                    );
                };

                if entry.computed || entry.method || entry.kind != PropertyKind::Init {
                    return fail(
                        "Variable registrations require literal descriptors.",
                        value.span,
                    );
                }

                let key = match &entry.key {
                    PropertyKey::StaticIdentifier(identifier) => identifier.name.to_string(),
                    key => statics::key_literal(key)
                        .map(Cow::into_owned)
                        .unwrap_or_default(),
                };
                let input = expression::unwrap(&entry.value);

                if key == "syntax"
                    && let Expression::Identifier(identifier) = input
                    && identifier.name == "undefined"
                    && undefined.contains(&identifier.span.start)
                {
                    continue;
                }

                let literal = match input {
                    Expression::StringLiteral(literal) => Some(Data::from(literal.value.as_str())),
                    Expression::NumericLiteral(literal) => Some(Data::Number(literal.value)),
                    Expression::BooleanLiteral(literal) => Some(Data::Bool(literal.value)),
                    Expression::UnaryExpression(unary)
                        if matches!(
                            unary.operator,
                            UnaryOperator::UnaryNegation | UnaryOperator::UnaryPlus
                        ) =>
                    {
                        match &unary.argument {
                            Expression::NumericLiteral(literal) => Some(Data::Number(
                                if unary.operator == UnaryOperator::UnaryNegation {
                                    -literal.value
                                } else {
                                    literal.value
                                },
                            )),
                            _ => None,
                        }
                    }
                    _ => None,
                };

                let Some(literal) = literal.filter(|_| {
                    matches!(key.as_str(), "id" | "syntax" | "inherits" | "initialValue")
                        && !descriptor.iter().any(|(name, _)| *name == key)
                }) else {
                    return fail("Invalid variable registration descriptor.", entry.span);
                };

                descriptor.push((key, literal));
            }
        }

        let field = |key: &str| {
            descriptor
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value)
        };
        let id = field("id");
        let explicit = id.is_some();
        let name = match id {
            None => format!(
                "--z-{}",
                authored.get(call.span.start).unwrap_or("undefined")
            ),
            Some(id) => {
                let identity = identity::require_id(id.as_str(), "variable")?;

                format!("--z-{}", identity.get(3..).unwrap_or_default())
            }
        };

        if let Some(value) = registration
            && descriptor.iter().any(|(key, _)| key != "id")
        {
            let syntax = match domain {
                Domain::SignedLength => "<length>".to_owned(),
                Domain::SignedPercentage => "<percentage>".to_owned(),
                domain => format!("<{}>", domain.as_str()),
            };
            let inherits = field("inherits");
            let initial_value = field("initialValue");
            let syntax_field = field("syntax");

            let (
                Some(Data::Bool(inherits)),
                Some(initial_value @ (Data::String(_) | Data::Number(_))),
            ) = (inherits, initial_value)
            else {
                return fail(
                    "Registration requires matching syntax, inherits, and an independent initialValue.",
                    value.span,
                );
            };

            if syntax_field.is_some_and(|field| field.as_str() != Some(syntax.as_str())) {
                return fail(
                    "Registration requires matching syntax, inherits, and an independent initialValue.",
                    value.span,
                );
            }

            if matches!(domain, Domain::Length | Domain::Percentage) {
                let text = initial_value.to_js_string();
                let valid = if domain == Domain::Length {
                    unsigned_length(&text)
                } else {
                    unsigned_percentage(&text)
                };

                if !valid {
                    return fail(
                        "Unsigned variable registrations require a nonnegative literal initialValue.",
                        value.span,
                    );
                }
            }

            let initial_value = match initial_value {
                Data::Number(number) => Scalar::Number(*number),
                other => Scalar::String(other.to_js_string().into()),
            };

            registration_starts.push(call.span.start);
            registration_locations.push(call.span);

            registrations.push(contributions::Definition {
                kind: contributions::Kind::Property {
                    inherits: *inherits,
                    initial_value: Some(initial_value),
                    name: Arc::from(name.as_str()),
                    syntax: Arc::from(syntax),
                },
                within: Vec::new(),
            });
        }

        let slot = Arc::new(binding::Reference {
            dynamic: false,
            domain,
            name: name.clone(),
            zero: false,
        });
        let mut slots = Record::new();

        slots.insert("value", slot);

        let entry = Call {
            end: call.span.end,
            explicit,
            slots: slots.clone(),
            start: call.span.start,
        };

        calls.push(entry);
        resolver.definitions.insert(
            call.span.start,
            Link {
                binding: Arc::from(name.as_str()),
                call: LinkCall {
                    end: call.span.end,
                    name: Arc::from(name.as_str()),
                    start: call.span.start,
                    token_type: Arc::from("{}"),
                    variable_owner: Some(Arc::from(owner(module_id))),
                    variables: Some(slots),
                    ..LinkCall::default()
                },
                definition: empty_definition()?,
                kind: LinkKind::Variables,
                members: None,
                style: None,
            },
        );
    }

    let mut references = IndexMap::default();
    let mut reads = Reads {
        ancestors: Vec::new(),
        reads: Vec::new(),
    };

    reads.visit_program(program);

    for (node, start, end) in reads.reads {
        let resolved = match node {
            Read::Identifier(start) => resolver.identifier(start, &mut FxHashSet::default())?,
            Read::Member(member) => resolver.member(member, &mut FxHashSet::default())?,
        };

        if let Some(reference) = resolved
            .as_ref()
            .and_then(|link| link.call.variables.as_ref())
            .and_then(|variables| variables.get("value"))
        {
            references.insert(
                start,
                VariableRead {
                    end,
                    reference: Arc::clone(reference),
                },
            );
        }
    }

    let mut exports = Record::new();

    for statement in &program.body {
        match statement {
            Statement::ExportDefaultDeclaration(export) => {
                if let Some(expression) = export.declaration.as_expression()
                    && let Some(link) = resolver.resolve(expression, &mut FxHashSet::default())?
                {
                    exports.insert("default", link);
                }
            }
            Statement::ExportDeclaration(export) => match &export.declaration {
                ast::Declaration::VariableDeclaration(declaration) => {
                    for variable in &declaration.declarations {
                        let (BindingPattern::BindingIdentifier(id), Some(init)) =
                            (&variable.id, &variable.init)
                        else {
                            continue;
                        };

                        if let Some(link) = resolver.resolve(init, &mut FxHashSet::default())? {
                            exports.insert(id.name.as_str(), link);
                        }
                    }
                }
                ast::Declaration::TSNamespaceDeclaration(namespace) if !dotted(namespace, None) => {
                    let values = members(namespace);

                    if let Some(link) =
                        resolver.group(&values, namespace.span.start, &FxHashSet::default())?
                    {
                        exports.insert(namespace.id.name.as_str(), link);
                    }
                }
                _ => {}
            },
            Statement::ExportNamedDeclaration(export) if !export.export_kind.is_type() => {
                for specifier in &export.specifiers {
                    if specifier.export_kind.is_type() {
                        continue;
                    }

                    if let Some(link) = resolver.local(&specifier.local)? {
                        exports.insert(export_name(&specifier.exported), link);
                    }
                }
            }
            Statement::ExportFromDeclaration(export) if !export.export_kind.is_type() => {
                for specifier in &export.specifiers {
                    if specifier.export_kind.is_type() {
                        continue;
                    }

                    if let Some(link) = resolver.local(&specifier.local)? {
                        exports.insert(export_name(&specifier.exported), link);
                    }
                }
            }
            _ => {}
        }
    }

    Ok(Variables {
        calls,
        exports,
        references,
        registration_locations,
        registrations,
        registration_starts,
        resolver,
    })
}

/// The module id without its script extension, matching `/\.[cm]?[jt]sx?$/`.
fn owner(module_id: &str) -> &str {
    for extension in [
        ".js", ".ts", ".jsx", ".tsx", ".cjs", ".cts", ".cjsx", ".ctsx", ".mjs", ".mts", ".mjsx",
        ".mtsx",
    ] {
        if let Some(stem) = module_id.strip_suffix(extension) {
            return stem;
        }
    }

    module_id
}

/// An empty theme definition, as `Theme.define({})` creates for each variable link.
fn empty_definition() -> Result<Arc<Definition>> {
    theme::define(&Data::from(Object::new()), None).map(Arc::new)
}

/// Spells a literal domain like `String(value)`.
fn literal_value(literal: &Expression<'_>) -> Option<String> {
    match literal {
        Expression::RegExpLiteral(literal) => literal.raw.as_ref().map(ToString::to_string),
        literal => expression::literal_text(literal),
    }
}

/// Matches the registered digits `(?:\d*\.\d+|\d+)(?:[eE][+-]?\d+)?` and returns the rest.
fn unsigned_number(text: &str) -> Option<&str> {
    let text = text.strip_prefix('+').unwrap_or(text);
    let length = js::css_number_prefix(text, b"");

    (length > 0).then(|| text.get(length..).unwrap_or_default())
}

/// Matches `^(?:0|\+?(?:\d*\.\d+|\d+)(?:[eE][+-]?\d+)?(?:px|in|cm|mm|q|pt|pc))$`.
fn unsigned_length(text: &str) -> bool {
    text == "0"
        || unsigned_number(text)
            .is_some_and(|unit| matches!(unit, "px" | "in" | "cm" | "mm" | "q" | "pt" | "pc"))
}

/// Matches `^\+?(?:\d*\.\d+|\d+)(?:[eE][+-]?\d+)?%$`.
fn unsigned_percentage(text: &str) -> bool {
    unsigned_number(text).is_some_and(|unit| unit == "%")
}

/// The first walk: identifier declarations, `const` initializers, namespaces, and calls.
struct Scan<'s, 'a> {
    ancestors: Vec<AstKind<'a>>,
    error: Option<Error>,
    factories: Vec<&'a CallExpression<'a>>,
    parsed: &'s Parsed<'a>,
    resolver: &'s mut Resolver<'a>,
    undefined: FxHashSet<u32>,
}

impl<'a> Visit<'a> for Scan<'_, 'a> {
    fn enter_node(&mut self, kind: AstKind<'a>) {
        if self.error.is_none()
            && let Err(error) = self.enter(kind)
        {
            self.error = Some(error);
        }

        self.ancestors.push(kind);
    }

    fn leave_node(&mut self, _: AstKind<'a>) {
        self.ancestors.pop();
    }
}

impl<'a> Scan<'_, 'a> {
    fn enter(&mut self, kind: AstKind<'a>) -> Result<()> {
        let parent = self.ancestors.last().copied();

        if let Some((span, name)) = identifier(kind, parent) {
            let semantic = &self.parsed.semantic;
            let scope = scope::scope_of(semantic, kind.node_id());
            let declaration = scope::lookup(semantic, name, scope, Mode::Value);

            match &declaration {
                Some(declaration) => {
                    self.resolver
                        .declarations
                        .insert(span.start, declaration.start());
                }
                None if name == "undefined" => {
                    self.undefined.insert(span.start);
                }
                None => {}
            }

            if let (AstKind::IdentifierReference(_), Some(declaration)) = (kind, &declaration)
                && declaration.kind == Kind::Import
                && self.resolver.imports.contains(&declaration.start())
                && value_reference(parent)
            {
                self.factory(kind, parent)?;
            }
        }

        match kind {
            AstKind::VariableDeclaration(declaration)
                if declaration.kind == VariableDeclarationKind::Const =>
            {
                for declarator in &declaration.declarations {
                    if let (BindingPattern::BindingIdentifier(_), Some(init)) =
                        (&declarator.id, &declarator.init)
                    {
                        self.resolver.bindings.insert(declarator.span.start, init);
                    }
                }
            }
            AstKind::TSNamespaceDeclaration(namespace) if !dotted(namespace, parent) => {
                self.resolver
                    .namespaces
                    .insert(namespace.id.span.start, members(namespace));
            }
            _ => {}
        }

        Ok(())
    }

    /// Validates a reference to the `variable` import: a direct call initializing a module-level
    /// constant or an object group.
    fn factory(&mut self, node: AstKind<'a>, parent: Option<AstKind<'a>>) -> Result<()> {
        let call = match parent {
            Some(AstKind::CallExpression(call))
                if call.callee.address() == node.address() && !call.optional =>
            {
                call
            }
            _ => {
                return fail(
                    "variable must be called directly in a module-level constant.",
                    node.span(),
                );
            }
        };
        let ancestors = estree_ancestors(&self.ancestors);
        let constant = ancestors.iter().any(|entry| {
            matches!(entry, AstKind::VariableDeclaration(declaration) if declaration.kind == VariableDeclarationKind::Const)
        });
        let nested = ancestors.iter().any(|entry| {
            matches!(
                entry,
                AstKind::ArrowFunctionExpression(_)
                    | AstKind::Function(_)
                    | AstKind::FunctionBody(_)
                    | AstKind::BlockStatement(_)
            )
        });

        if !constant || nested {
            return fail("variable requires a module-level constant.", call.span);
        }

        let mut initializer: Address = parent.map_or(node.address(), |parent| parent.address());
        let mut initializer_span = call.span;

        for ancestor in ancestors.iter().rev().skip(1) {
            if let AstKind::VariableDeclarator(declarator) = ancestor
                && matches!(declarator.id, BindingPattern::BindingIdentifier(_))
                && declarator
                    .init
                    .as_ref()
                    .is_some_and(|init| init.address() == initializer)
            {
                break;
            }

            if !matches!(ancestor, AstKind::VariableDeclarator(_)) {
                let wraps = match ancestor {
                    AstKind::TSAsExpression(_)
                    | AstKind::TSSatisfiesExpression(_)
                    | AstKind::TSNonNullExpression(_)
                    | AstKind::TSTypeAssertion(_) => wraps(*ancestor, initializer_span),
                    _ => false,
                };
                let property = matches!(ancestor, AstKind::ObjectProperty(property)
                    if !property.computed
                        && property.kind == PropertyKind::Init
                        && !property.method
                        && property.value.address() == initializer);
                let object = matches!(ancestor, AstKind::ObjectExpression(object)
                    if object.properties.iter().any(|property| property.address() == initializer));

                if wraps || property || object {
                    initializer = ancestor.address();
                    initializer_span = ancestor.span();
                    continue;
                }
            }

            return fail(
                "variable requires a direct constant or object-group initializer.",
                call.span,
            );
        }

        self.factories.push(call);

        Ok(())
    }
}

/// Whether a TypeScript wrapper surrounds the node at `span`: both unwrap to one expression.
fn wraps(ancestor: AstKind<'_>, span: Span) -> bool {
    let inner = match ancestor {
        AstKind::TSAsExpression(inner) => &inner.expression,
        AstKind::TSSatisfiesExpression(inner) => &inner.expression,
        AstKind::TSNonNullExpression(inner) => &inner.expression,
        AstKind::TSTypeAssertion(inner) => &inner.expression,
        _ => return false,
    };
    let unwrapped = expression::unwrap(inner).span();

    unwrapped.start >= span.start && unwrapped.end <= span.end
}

/// A node whose read the second walk resolves.
#[derive(Clone, Copy)]
enum Read<'a> {
    /// An ESTree `Identifier`, by start.
    Identifier(u32),
    /// A member read.
    Member(Member<'a>),
}

/// A member read: its object, key, optional flag, and identity.
#[derive(Clone, Copy)]
struct Member<'a> {
    address: Address,
    key: Option<&'a str>,
    literal: Option<&'a Expression<'a>>,
    object: &'a Expression<'a>,
    optional: bool,
}

impl<'a> Member<'a> {
    fn of_kind(kind: AstKind<'a>) -> Option<Self> {
        let address = kind.address();

        match kind {
            AstKind::StaticMemberExpression(member) => Some(Self {
                address,
                key: Some(member.property.name.as_str()),
                literal: None,
                object: &member.object,
                optional: member.optional,
            }),
            AstKind::ComputedMemberExpression(member) => Some(Self {
                address,
                key: None,
                literal: Some(&member.expression)
                    .filter(|expression| statics::is_literal(expression)),
                object: &member.object,
                optional: member.optional,
            }),
            AstKind::PrivateFieldExpression(member) => Some(Self {
                address,
                key: None,
                literal: None,
                object: &member.object,
                optional: member.optional,
            }),
            _ => None,
        }
    }

    fn of_expression(expression: &'a Expression<'a>) -> Option<Self> {
        let address = expression.address();

        match expression {
            Expression::StaticMemberExpression(member) => Some(Self {
                address,
                key: Some(member.property.name.as_str()),
                literal: None,
                object: &member.object,
                optional: member.optional,
            }),
            Expression::ComputedMemberExpression(member) => Some(Self {
                address,
                key: None,
                literal: Some(&member.expression)
                    .filter(|expression| statics::is_literal(expression)),
                object: &member.object,
                optional: member.optional,
            }),
            Expression::PrivateFieldExpression(member) => Some(Self {
                address,
                key: None,
                literal: None,
                object: &member.object,
                optional: member.optional,
            }),
            _ => None,
        }
    }

    /// A static name, or any computed literal spelled like `String(value)`.
    fn key(&self) -> Option<String> {
        match (self.key, self.literal) {
            (Some(key), _) => Some(key.to_owned()),
            (None, Some(literal)) => literal_value(literal),
            (None, None) => None,
        }
    }
}

/// The second walk: every ESTree `Identifier` and `MemberExpression`.
struct Reads<'a> {
    ancestors: Vec<AstKind<'a>>,
    reads: Vec<(Read<'a>, u32, u32)>,
}

impl<'a> Visit<'a> for Reads<'a> {
    fn enter_node(&mut self, kind: AstKind<'a>) {
        let parent = self.ancestors.last().copied();

        if let Some((span, _)) = identifier(kind, parent) {
            self.reads
                .push((Read::Identifier(span.start), span.start, span.end));
        } else if let Some(member) = Member::of_kind(kind) {
            let span = kind.span();

            self.reads
                .push((Read::Member(member), span.start, span.end));
        }

        self.ancestors.push(kind);
    }

    fn leave_node(&mut self, _: AstKind<'a>) {
        self.ancestors.pop();
    }
}

impl<'a> Resolver<'a> {
    /// Resolves an identifier by its start through its recorded declaration.
    fn identifier(&self, start: u32, seen: &mut FxHashSet<Address>) -> Result<Option<Link>> {
        let Some(declaration) = self.declarations.get(&start).copied() else {
            return Ok(None);
        };

        if let Some(imported) = self.external.get(&declaration) {
            return Ok(Some(imported.clone()));
        }

        if let Some(values) = self.namespaces.get(&declaration) {
            return self.group(values, declaration, seen);
        }

        match self.bindings.get(&declaration).copied() {
            Some(value) => self.resolve(value, seen),
            None => Ok(None),
        }
    }

    /// Resolves an export specifier's local name.
    fn local(&self, name: &ModuleExportName<'a>) -> Result<Option<Link>> {
        match name {
            ModuleExportName::IdentifierName(identifier) => {
                self.identifier(identifier.span.start, &mut FxHashSet::default())
            }
            ModuleExportName::IdentifierReference(identifier) => {
                self.identifier(identifier.span.start, &mut FxHashSet::default())
            }
            ModuleExportName::StringLiteral(_) => Ok(None),
        }
    }

    /// Resolves a member read through a group's members.
    fn member(&self, member: Member<'a>, seen: &mut FxHashSet<Address>) -> Result<Option<Link>> {
        if !seen.insert(member.address) || member.optional {
            return Ok(None);
        }

        let Some(key) = member.key() else {
            return Ok(None);
        };

        Ok(self
            .resolve(member.object, seen)?
            .and_then(|link| link.members.and_then(|members| members.get(&key).cloned())))
    }

    /// Resolves an expression to a variable or a group of variables.
    fn resolve(
        &self,
        input: &'a Expression<'a>,
        seen: &mut FxHashSet<Address>,
    ) -> Result<Option<Link>> {
        let node = expression::unwrap(input);

        if let Some(member) = Member::of_expression(node) {
            return self.member(member, seen);
        }

        if !seen.insert(node.address()) {
            return Ok(None);
        }

        match node {
            Expression::CallExpression(call) => Ok(self.definitions.get(&call.span.start).cloned()),
            Expression::Identifier(identifier) => self.identifier(identifier.span.start, seen),
            Expression::ObjectExpression(object) => {
                let mut values: Vec<(Arc<str>, &'a Expression<'a>)> = Vec::new();

                for property in &object.properties {
                    let ObjectPropertyKind::ObjectProperty(property) = property else {
                        return Ok(None);
                    };

                    if property.method || property.kind != PropertyKind::Init || property.computed {
                        return Ok(None);
                    }

                    let key = match &property.key {
                        PropertyKey::StaticIdentifier(identifier) => {
                            Some(Cow::Borrowed(identifier.name.as_str()))
                        }
                        key => statics::key_literal(key),
                    };

                    if let Some(key) = key {
                        let key = Arc::from(key);

                        match values.iter_mut().find(|(name, _)| *name == key) {
                            Some(entry) => entry.1 = &property.value,
                            None => values.push((key, &property.value)),
                        }
                    }
                }

                self.group(&values, object.span.start, seen)
            }
            _ => Ok(None),
        }
    }

    /// Links the members of an object group or namespace that resolve to variables.
    fn group(
        &self,
        values: &[(Arc<str>, &'a Expression<'a>)],
        start: u32,
        seen: &FxHashSet<Address>,
    ) -> Result<Option<Link>> {
        let mut members: Record<Link> = Record::new();

        for (name, value) in values {
            if let Some(member) = self.resolve(value, &mut seen.clone())? {
                members.insert(Arc::clone(name), member);
            }
        }

        if members.is_empty() {
            return Ok(None);
        }

        Ok(Some(Link {
            binding: format!("z-v{}-{}", self.namespace, self.utf16.utf16(start)).into(),
            call: LinkCall {
                token_type: Arc::from("{}"),
                variables: Some(Record::new()),
                ..LinkCall::default()
            },
            definition: empty_definition()?,
            kind: LinkKind::Variables,
            members: Some(members),
            style: None,
        }))
    }
}

impl<'a> Variables<'a> {
    /// Whether the module declares variables, so references need their ancestors.
    pub fn declares(&self) -> bool {
        !self.resolver.declarations.is_empty()
    }

    /// Resolves one identifier read during the extraction walk.
    ///
    /// `node` is an `IdentifierReference` or a JSX identifier, `ancestors` lists the walk's
    /// ancestors from the program down to `node` inclusive, and `binding` is the declaration
    /// `node` resolves to. Returns whether the read names a variable or the `variable` import.
    ///
    /// # Errors
    ///
    /// Returns `Source.ThemeInvalidError` for a module-scope read that precedes its declaration.
    pub fn reference(
        &self,
        node: AstKind<'a>,
        ancestors: &[AstKind<'a>],
        binding: Option<&Declaration<'a>>,
    ) -> Result<bool> {
        if binding.is_some_and(|binding| {
            binding.kind == Kind::Import && self.resolver.imports.contains(&binding.start())
        }) {
            return Ok(true);
        }

        // Every link starts from a declaration, so a module without one reads no variables.
        if self.resolver.declarations.is_empty() {
            return Ok(false);
        }

        let ancestors = estree_ancestors(ancestors);
        let parent = ancestors
            .len()
            .checked_sub(2)
            .and_then(|index| ancestors.get(index))
            .copied();
        let AstKind::IdentifierReference(identifier) = node else {
            return Ok(false);
        };

        if jsx(parent) {
            return Ok(false);
        }

        let member = parent
            .and_then(Member::of_kind)
            .filter(|member| member.object.address() == node.address());
        let link = match member {
            Some(member) => self.resolver.member(member, &mut FxHashSet::default())?,
            None => None,
        };
        let link = match link {
            Some(link) => Some(link),
            None => self
                .resolver
                .identifier(identifier.span.start, &mut FxHashSet::default())?,
        };
        let Some(link) = link else {
            return Ok(false);
        };
        // Reads inside functions wait for a call, so only module-scope reads must follow the
        // declaration. Linked calls have zero offsets, which no read precedes.
        let deferred = ancestors.iter().any(|ancestor| {
            matches!(
                ancestor,
                AstKind::ArrowFunctionExpression(_) | AstKind::Function(_)
            )
        });

        if identifier.span.start < link.call.end && !deferred {
            return fail("Vars must be declared before use.", identifier.span);
        }

        Ok(true)
    }
}
