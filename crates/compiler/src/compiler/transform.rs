//! Rewrites extracted style calls into executable modules with CSS and source maps.
//!
//! Direct no-argument applications become props, other definitions become callables, and the
//! module's CSS keeps ordered composition with module-scoped class identities. Containment tests
//! over call ranges use sorted interval tables, so rewriting stays linear in the number of calls.

use std::borrow::Cow;
use std::fmt::Write as _;
use std::sync::Arc;

use indexmap::IndexMap;
use oxc_ast::AstKind;
use oxc_ast::ast::{
    Argument, ArrayExpressionElement, BindingPattern, Expression, ImportDeclarationSpecifier,
    ImportOrExportKind, ObjectExpression, ObjectPropertyKind, Program, PropertyKey, PropertyKind,
    Statement,
};
use oxc_span::{GetSpan, Span};
use rustc_hash::{FxBuildHasher, FxHashMap, FxHashSet};
use smallvec::SmallVec;

use crate::compiler::internal::applications::{self, Application, Bound};
use crate::compiler::internal::contributions::Factory;
use crate::compiler::internal::dynamic;
use crate::compiler::internal::expression::unwrap;
use crate::compiler::internal::packed_styles;
use crate::compiler::internal::statics::key_literal;
use crate::compiler::internal::syntax::Parsed;
use crate::compiler::internal::themes::{self, Output as ThemeOutput};
use crate::compiler::source::{Call, Extracted, KnownInput, RuntimeInput};
use crate::data::Data;
use crate::error::{Error, Result};
use crate::internal::token::{Composition, CssOutput, Reference};
use crate::internal::{identity, scheme};
use crate::js::{self, Utf16Index};
use crate::mapping::edits::Edits;
use crate::mapping::gen_mapping::{EncodedSourceMap, GenMapping, Mapping, Position};
use crate::mapping::magic_string::{MagicString, MapOptions};
use crate::runtime::recipe as runtime;
use crate::style::{Declaration, NamedStyle};
use crate::web::css;
use crate::web::internal::class_name::{self, Registry, Units, Used, Visibility};
use crate::web::internal::contributions;
use crate::web::internal::themes::{Resource, Scope, Shared};

/// Inputs of one module's web transform.
#[expect(
    clippy::struct_excessive_bools,
    reason = "Each flag is an independent host option."
)]
pub struct Options<'s, 'a> {
    /// Rewrites authoring calls. `false` emits CSS for unchanged source.
    pub compiler: bool,
    /// Composition for styles without their own mode.
    pub composition: Option<CssComposition>,
    /// Defining calls of the graph's theme scopes, by scope key.
    pub owners: Option<&'s Owners>,
    /// Class names of styles compiled elsewhere in the graph, by style identity.
    pub style_classes: Option<&'s FxHashMap<Arc<str>, Arc<str>>>,
    /// Default CSS representation for styles without their own mode.
    pub css_output: Option<CssOutput>,
    /// Leaves token resources and scope rules to a graph that emits them once, returning
    /// [`Output::references`] instead.
    pub deferred_scopes: bool,
    /// Keeps live definitions for development updates.
    pub development: bool,
    /// An untyped host supplied a default CSS output that is neither atomic nor grouped, which
    /// the module's CSS compilation reports.
    pub invalid_css_output: bool,
    /// Portable module identity.
    pub module_id: &'s str,
    /// Content written as `0` in both source maps. A host that supplied the source separately
    /// restores it, so the text crosses the boundary once.
    pub placeholder: Option<&'a str>,
    /// Identity classes that selectors of a complete graph reference. Class lists then omit
    /// every other generated identity, while explicit ids remain. `None` keeps every identity.
    pub referenced: Option<&'s FxHashSet<Arc<str>>>,
    /// Emits the color-scheme selection classes. Defaults to the module's own scheme helpers.
    pub schemes: Option<bool>,
    /// Separates generated token rules for independently loaded modules.
    pub shared: Option<Shared>,
    /// Complete module text.
    pub source: &'a str,
}

/// Defining calls of theme scopes, by scope key, in registration order.
pub type Owners = IndexMap<Arc<str>, themes::Owner, FxBuildHasher>;

/// Composition mode for compiled applications.
pub type CssComposition = Composition;

/// Executable module and stylesheet artifacts. TypeScript and JSX lowering belongs to the host.
#[derive(Debug)]
pub struct Output {
    /// Module-scoped class lists by definition name.
    pub classes: IndexMap<Arc<str>, String, FxBuildHasher>,
    /// Rewritten source.
    pub code: String,
    /// Ordered, unminified stylesheet text.
    pub css: String,
    /// Stylesheet map with authored selector and declaration locations.
    pub css_map: EncodedSourceMap,
    /// Rewritten-module map with original source content, as JSON.
    pub map: String,
    /// Token references whose resources [`Options::deferred_scopes`] left to the graph.
    pub references: Option<Arc<[Arc<Reference>]>>,
    /// Exact emitted rules, for collision diagnostics.
    pub rules: IndexMap<String, String, FxBuildHasher>,
    /// Generated token resources delivered beside this module's CSS.
    pub shared: Option<Vec<Resource>>,
    /// Shared rule names this module chose.
    pub units: Used,
    /// Scope classes by theme label.
    pub vars: IndexMap<Arc<str>, String, FxBuildHasher>,
}

/// Whether two outputs serialize identically, comparing every record in order.
pub fn same(left: &Output, right: &Output) -> bool {
    left.code == right.code
        && left.css == right.css
        && left.map == right.map
        && left.css_map == right.css_map
        && left.references == right.references
        && left.classes.iter().eq(right.classes.iter())
        && left.rules.iter().eq(right.rules.iter())
        && left.units.iter().eq(right.units.iter())
        && left.vars.iter().eq(right.vars.iter())
        && left.shared == right.shared
}

fn message(text: &str) -> Error {
    Error::Message(text.to_owned())
}

/// Whether the module id names a TypeScript module, as `/\.[cm]?tsx?$/` tests.
fn typed(module_id: &str) -> bool {
    let Some(index) = module_id.rfind('.') else {
        return false;
    };
    let extension = &module_id[index + 1..];
    let extension = extension.strip_prefix(['c', 'm']).unwrap_or(extension);

    extension == "ts" || extension == "tsx"
}

/// Ranges sorted by start with the running maximum end, for strict containment queries.
struct Intervals {
    ends: Vec<u32>,
    starts: Vec<u32>,
}

impl Intervals {
    fn new(mut ranges: Vec<(u32, u32)>) -> Self {
        ranges.sort_unstable();

        let mut maximum = 0;
        let ends = ranges
            .iter()
            .map(|(_, end)| {
                maximum = maximum.max(*end);
                maximum
            })
            .collect();

        Self {
            ends,
            starts: ranges.into_iter().map(|(start, _)| start).collect(),
        }
    }

    /// Whether a range starting strictly before `start` ends at or after `end`. Call ranges nest
    /// or are disjoint, so such a range contains the query.
    fn contains(&self, start: u32, end: u32) -> bool {
        let count = self.starts.partition_point(|candidate| *candidate < start);

        count > 0
            && self
                .ends
                .get(count - 1)
                .is_some_and(|maximum| *maximum >= end)
    }
}

/// One folded or rewritten application of a definition call.
#[derive(Clone, Copy)]
struct Applied {
    end: u32,
    folded: bool,
}

struct Walker<'w, 'a> {
    applications: FxHashMap<u32, Applied>,
    calls: &'w FxHashMap<u32, &'w Call<'a>>,
    definitions: FxHashMap<u32, &'a ObjectExpression<'a>>,
    /// Spans of identifiers spelled like an import's local name or a generated `__zyzz` helper,
    /// the only names the rewrite looks up.
    identifiers: FxHashMap<&'a str, Vec<Span>>,
    /// Local names of the module's imports.
    imports: SmallVec<[&'a str; 8]>,
    unused_selections: FxHashSet<u32>,
}

impl<'a> Walker<'_, 'a> {
    fn identifier(&mut self, name: &'a str, span: Span) {
        if name.starts_with("__zyzz") || self.imports.contains(&name) {
            self.identifiers.entry(name).or_default().push(span);
        }
    }
}

impl<'a> Walker<'_, 'a> {
    /// Records nodes in entry order from the semantic node list, which also holds each node's
    /// parent, so no walk is needed.
    fn scan(&mut self, semantic: &oxc_semantic::Semantic<'a>) {
        let nodes = semantic.nodes();

        for node in nodes.iter() {
            let id = node.id();
            let kind = node.kind();
            // Only identifier reads and calls inspect their parent.
            let parent = (matches!(
                kind,
                AstKind::IdentifierReference(_) | AstKind::CallExpression(_)
            ) && nodes.parent_id(id) != id)
                .then(|| nodes.parent_kind(id));

            self.enter(kind, parent);
        }
    }

    fn enter(&mut self, kind: AstKind<'a>, parent: Option<AstKind<'a>>) {
        match kind {
            AstKind::VariableDeclarator(declarator) => {
                if let (Some(init), BindingPattern::ObjectPattern(pattern)) = (&declarator.init, &declarator.id)
                    && pattern.rest.is_none()
                    && pattern.properties.iter().all(|property| {
                        let name = match &property.key {
                            PropertyKey::StaticIdentifier(identifier) => Some(Cow::Borrowed(identifier.name.as_str())),
                            key => key_literal(key),
                        };
                        let variables =
                            matches!(&property.key, PropertyKey::StaticIdentifier(identifier) if identifier.name == "variables");

                        name.as_deref() != Some("themes") && !variables
                    })
                {
                    self.unused_selections.insert(unwrap(init).span().start);
                }
            }
            AstKind::IdentifierReference(identifier) => {
                // ESTree spells JSX element names as JSXIdentifier rather than Identifier.
                if !matches!(
                    parent,
                    Some(AstKind::JSXOpeningElement(_) | AstKind::JSXClosingElement(_) | AstKind::JSXMemberExpression(_))
                ) {
                    self.identifier(identifier.name.as_str(), identifier.span);
                }
            }
            AstKind::BindingIdentifier(identifier) => {
                self.identifier(identifier.name.as_str(), identifier.span);
            }
            AstKind::IdentifierName(identifier) => {
                self.identifier(identifier.name.as_str(), identifier.span);
            }
            AstKind::LabelIdentifier(identifier) => {
                self.identifier(identifier.name.as_str(), identifier.span);
            }
            AstKind::CallExpression(node) => {
                let Some(call) = self.calls.get(&node.span.start).filter(|call| call.end == node.span.end) else {
                    return;
                };
                let outer = match parent {
                    Some(AstKind::CallExpression(outer)) if outer.callee.span() == node.span && !outer.optional => {
                        Some(outer)
                    }
                    _ => None,
                };
                let folded = call.composition.is_some()
                    || (call.recipe.is_none() && call.slots.is_none() && outer.is_some_and(|outer| outer.arguments.is_empty()));
                let end = match outer {
                    Some(outer) if folded && call.composition.is_none() => outer.span.end,
                    _ => call.end,
                };

                self.applications.insert(call.start, Applied { end, folded });

                let mut argument = node.arguments.first().and_then(Argument::as_expression).map(unwrap);

                if let Some(Expression::ArrowFunctionExpression(arrow)) = argument {
                    argument = arrow.get_expression().map(unwrap);
                }

                if let Some(body) = call.body {
                    self.definitions.insert(call.start, body);
                } else if let Some(Expression::ObjectExpression(body)) = argument {
                    self.definitions.insert(call.start, body);
                }
            }
            _ => {}
        }
    }
}

/// A name unused by the module's identifiers, extended with `_` as the TypeScript compiler does.
fn unique(identifiers: &FxHashMap<&str, Vec<Span>>, base: &str) -> String {
    let mut name = base.to_owned();

    while identifiers.contains_key(name.as_str()) {
        name.push('_');
    }

    name
}

fn quote(value: &str) -> String {
    js::quote(value)
}

fn write_strings(output: &mut String, values: &[Arc<str>]) {
    output.push('[');

    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }

        js::write_string(output, value);
    }

    output.push(']');
}

fn write_scalar(output: &mut String, value: &runtime::Scalar) {
    match value {
        runtime::Scalar::Number(number) => js::write_number(output, *number),
        runtime::Scalar::String(text) => js::write_string(output, text),
    }
}

fn write_axes(output: &mut String, recipe: &runtime::Definition) {
    js::write_object(
        output,
        recipe.axes.iter().map(|(axis, choices)| (&**axis, choices)),
        |output, choices| {
            write_strings(output, choices);
        },
    );
}

fn write_defaults(output: &mut String, recipe: &runtime::Definition) {
    js::write_object(
        output,
        recipe
            .defaults
            .iter()
            .map(|(axis, choice)| (&**axis, choice)),
        |output, choice| match choice {
            Some(choice) => js::write_string(output, choice),
            None => output.push_str("null"),
        },
    );
}

/// Writes a selector equivalent to `Recipe.create` for one unconditional recipe without payloads.
/// Its fixed axes read constant keys, so each call stays monomorphic.
fn write_selector(
    output: &mut String,
    recipe: &runtime::Definition,
    class_name: &str,
    typed: bool,
) {
    let parameter = if typed {
        ":Record<string,unknown>&import('zyzz').style.Options"
    } else {
        ""
    };
    let result = if typed { ":Record<string,unknown>" } else { "" };
    // A nonempty class list is always truthy, so only an override decides the join.
    let joined = if class_name.len() > 2 && class_name.starts_with('"') {
        format!("external?{class_name}+\" \"+external:{class_name}")
    } else {
        format!("external||{class_name}")
    };

    let _ = write!(
        output,
        "((input{parameter}={{}})=>{{const external=input.className,style=input.style,vars=input.vars,inline=vars?{{...vars,...style}}:style,className={joined},result{result}=inline?{{className,style:inline}}:{{className}};let value;"
    );

    for axis in recipe.axes.keys() {
        let mut key = String::new();

        js::write_string(&mut key, axis);
        let _ = write!(
            output,
            "value=Object.hasOwn(input,{key})?input[{key}]:void 0;"
        );

        if let Some(Some(fallback)) = recipe.defaults.get(axis) {
            output.push_str("if(value===void 0)value=");
            js::write_string(output, fallback);
            output.push(';');
        }

        output.push_str("if(value!==null&&value!==void 0)result[");
        js::write_string(output, &format!("data-{axis}"));
        output.push_str("]=String(value);");
    }

    output.push_str("return result})");
}

/// `JSON.stringify({ ...recipe, html })`, in the key order `Recipes.expand` builds.
fn write_recipe(output: &mut String, recipe: &runtime::Definition, html: bool) {
    output.push_str("{\"axes\":");
    write_axes(output, recipe);
    output.push_str(",\"defaults\":");
    write_defaults(output, recipe);

    if let Some(payloads) = &recipe.payloads {
        output.push_str(",\"payloads\":[");

        for (index, payload) in payloads.iter().enumerate() {
            if index > 0 {
                output.push(',');
            }

            output.push_str("{\"axis\":");
            js::write_string(output, &payload.axis);
            output.push_str(",\"choice\":");
            js::write_string(output, &payload.choice);
            output.push_str(",\"slots\":[");

            for (index, slots) in payload.slots.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }

                js::write_object(
                    output,
                    slots.iter().map(|(field, slot)| (&**field, slot)),
                    |output, slot| {
                        js::write_string(output, slot);
                    },
                );
            }

            output.push_str("]}");
        }

        output.push(']');

        if let Some(defaults) = &recipe.default_payloads {
            output.push_str(",\"defaultPayloads\":");
            js::write_object(
                output,
                defaults.iter().map(|(axis, values)| (&**axis, values)),
                |output, values| {
                    js::write_object(
                        output,
                        values.iter().map(|(field, value)| (&**field, value)),
                        write_scalar,
                    );
                },
            );
        }
    }

    if let Some(conditions) = &recipe.conditions {
        output.push_str(",\"conditions\":");
        write_strings(output, conditions);
    }

    output.push_str(",\"html\":");
    output.push_str(if html { "true" } else { "false" });
    output.push('}');
}

/// The JSON-encoded string, or `undefined` spelled by `JSON.stringify` inside a template.
fn json_class(classes: &IndexMap<Arc<str>, String, FxBuildHasher>, name: &str) -> String {
    classes
        .get(name)
        .map_or_else(|| "undefined".to_owned(), |value| quote(value))
}

/// Folds a dynamic application into its props, writing each field that fills one declaration to
/// that property and each other field to its private variable.
///
/// Values keep their authored text and order, so edits inside them still apply. An empty string
/// writes `unset` to a property, the value a declaration takes when its variable is invalid at
/// computed-value time, and a space to a variable, as the generated callable does. The emitted rule
/// still reads the variable of an inlined field, which no folded application assigns.
fn fold_bound(
    module: &mut Edits<'_>,
    source: &str,
    application: &Bound<'_>,
    slots: &dynamic::Slots,
    properties: &js::Record<&str>,
    class_name: &str,
) -> Result<()> {
    // Each field's key with its text before and after the authored value.
    let mut fields: SmallVec<[(&str, String, &str, Span); 4]> = SmallVec::new();
    let mut seen: FxHashSet<&str> = FxHashSet::default();

    for property in &application.values.properties {
        let ObjectPropertyKind::ObjectProperty(property) = property else {
            return Ok(());
        };

        if property.computed || property.method || property.kind != PropertyKind::Init {
            return Ok(());
        }

        let key = match &property.key {
            PropertyKey::StaticIdentifier(identifier) => identifier.name.as_str(),
            PropertyKey::StringLiteral(literal) => literal.value.as_str(),
            _ => return Ok(()),
        };
        let Some(slot) = slots.get(key) else {
            return Ok(());
        };

        if !seen.insert(key) {
            return Ok(());
        }

        let field = match properties.get(key) {
            Some(target) => (
                key,
                format!("{}:(", quote(target)),
                ")||\"unset\"",
                property.value.span(),
            ),
            None => (
                key,
                format!("{}:`${{(", quote(&slot.name)),
                ")}`||\" \"",
                property.value.span(),
            ),
        };

        fields.push(field);
    }

    if fields.len() != slots.len() || properties.is_empty() {
        return Ok(());
    }

    let callee = source
        .get(application.start as usize..application.callee_end as usize)
        .unwrap_or_default();
    let mut previous = application.start;
    let mut closing = "";

    for (index, (_, opening, close, value)) in fields.iter().enumerate() {
        let mut text = String::with_capacity(callee.len() + class_name.len() + opening.len() + 24);

        if index == 0 {
            if application.initialized {
                text.push('(');
            } else {
                // Keep a callable guard so bundlers also keep failures before initialization.
                let _ = write!(text, "({callee}?");
            }

            let _ = write!(text, "{{className:{class_name},style:{{");
        } else {
            text.push_str(closing);
            text.push(',');
        }

        text.push_str(opening);
        module.overwrite(previous, value.start, text)?;
        previous = value.end;
        closing = close;
    }

    let suffix = if application.initialized {
        format!("{closing}}}}})")
    } else {
        format!("{closing}}}}}:{callee}())")
    };

    module.overwrite(previous, application.end, suffix)
}

/// Locates emitted declarations, skipping selectors, conditions, and quoted CSS data. Offsets are
/// UTF-8 byte offsets into `body`.
fn declaration_starts(
    body: &str,
    conditions: bool,
    mut openers: Option<&mut FxHashMap<usize, usize>>,
    starts: &mut Vec<usize>,
) {
    let bytes = body.as_bytes();

    starts.clear();

    let mut start = 0;
    let mut depth: i32 = 0;
    let mut blocks = 0;
    let mut custom = false;
    let mut quote: Option<u8> = None;
    let mut index = 0;

    while index < bytes.len() {
        let character = bytes[index];

        if character == b'\\' {
            // Skip the escaped character, which may span several bytes.
            index += 1;
            index += body[index.min(body.len())..]
                .chars()
                .next()
                .map_or(1, char::len_utf8);
            continue;
        }

        if let Some(open) = quote {
            if character == open {
                quote = None;
            }

            index += 1;
            continue;
        }

        if character == b'"' || character == b'\'' {
            quote = Some(character);
            index += 1;
            continue;
        }

        if character == b'/' && bytes.get(index + 1) == Some(&b'*') {
            let Some(end) = body[index + 2..].find("*/") else {
                break;
            };

            index += 2 + end + 2;
            continue;
        }

        match character {
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth -= 1,
            _ if depth != 0 => {}
            b':' if body[start..index]
                .trim_start_matches(js::is_whitespace)
                .starts_with("--") =>
            {
                custom = true;
            }
            b'{' => {
                if custom {
                    blocks += 1;
                } else {
                    if conditions && index > start {
                        starts.push(start);

                        if let Some(openers) = openers.as_deref_mut() {
                            openers.insert(start, index);
                        }
                    }

                    start = index + 1;
                }
            }
            b'}' => {
                if blocks > 0 {
                    blocks -= 1;
                } else {
                    start = index + 1;
                    custom = false;
                }
            }
            b';' if blocks == 0 => {
                while start < index && body[start..].chars().next().is_some_and(js::is_whitespace) {
                    start += body[start..].chars().next().map_or(1, char::len_utf8);
                }

                if !conditions {
                    starts.push(start);
                }

                start = index + 1;
                custom = false;
            }
            _ => {}
        }

        index += 1;
    }
}

/// Splits a class list at each space, as `split(' ')` does. Lists are short, so a byte scan beats
/// the `memchr` dispatch a `char` pattern performs for every name.
fn split_spaces(list: &str) -> impl Iterator<Item = &str> {
    let bytes = list.as_bytes();
    let mut start = Some(0);

    std::iter::from_fn(move || {
        let from = start?;
        let end = bytes
            .get(from..)?
            .iter()
            .position(|byte| *byte == b' ')
            .map(|offset| from + offset);

        start = end.map(|end| end + 1);
        list.get(from..end.unwrap_or(bytes.len()))
    })
}

/// The brace of a rule whose selector is one unescaped class and whose body opens no other
/// block, as [`declaration_starts`] would find it.
fn simple_block(rule: &str) -> Option<usize> {
    let bytes = rule.as_bytes();
    let brace = memchr::memchr(b'{', bytes)?;
    let selector = bytes.get(1..brace)?;

    (bytes.first() == Some(&b'.')
        && !selector.is_empty()
        && selector
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'-')
        && memchr::memchr(b'{', bytes.get(brace + 1..)?).is_none())
    .then_some(brace)
}

/// Decodes `\hex ` escapes in a class selector, as `/\\([0-9a-f]+) ?/gi` replacements do.
fn unescape(selector: &str) -> Cow<'_, str> {
    if !selector.contains('\\') {
        return Cow::Borrowed(selector);
    }

    let mut output = String::with_capacity(selector.len());
    let mut rest = selector;

    while let Some(index) = rest.find('\\') {
        output.push_str(&rest[..index]);

        let after = &rest[index + 1..];
        let digits = after.bytes().take_while(u8::is_ascii_hexdigit).count();

        if digits == 0 {
            output.push('\\');
            rest = after;
            continue;
        }

        let code = u32::from_str_radix(&after[..digits], 16)
            .ok()
            .and_then(char::from_u32);

        output.push(code.unwrap_or('\u{fffd}'));
        rest = &after[digits..];
        rest = rest.strip_prefix(' ').unwrap_or(rest);
    }

    output.push_str(rest);
    Cow::Owned(output)
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

fn collect_conditions(style: &NamedStyle, conditions: &mut Vec<Arc<str>>) {
    for rule in style.rules.iter().flatten() {
        if let Some(condition) = &rule.condition {
            conditions.push(Arc::clone(condition));
        }

        collect_conditions(&rule.style, conditions);
    }
}

/// Whether text starts with a property's kebab-case name and a colon, as `name:` declares it.
fn declares(text: &str, property: &str) -> bool {
    let mut rest = text.as_bytes().iter();

    for byte in property.bytes() {
        if byte.is_ascii_uppercase() {
            if rest.next() != Some(&b'-') || rest.next() != Some(&byte.to_ascii_lowercase()) {
                return false;
            }
        } else if rest.next() != Some(&byte) {
            return false;
        }
    }

    rest.next() == Some(&b':')
}

/// The byte length of a property's kebab-case name and its colon.
fn declaration_length(property: &str) -> usize {
    property.len() + property.bytes().filter(u8::is_ascii_uppercase).count() + 1
}

/// An owning call's authored data, read once for all of its rules.
#[derive(Default)]
struct Authored<'s> {
    condition_nodes: Vec<Span>,
    conditions: Vec<Arc<str>>,
    declarations: Vec<&'s Declaration>,
    locations: Vec<u32>,
    /// Declarations an earlier rule of the owner already mapped.
    used: Vec<bool>,
}

/// One-based lines and UTF-16 columns of source offsets.
struct Lines<'s> {
    offsets: &'s Utf16Index,
    starts: Vec<u32>,
}

impl<'s> Lines<'s> {
    fn new(source: &str, offsets: &'s Utf16Index) -> Self {
        let mut starts = vec![0];

        starts.extend(
            memchr::memchr_iter(b'\n', source.as_bytes())
                .filter_map(|index| u32::try_from(index + 1).ok()),
        );

        Self { offsets, starts }
    }

    fn position(&self, offset: u32) -> Position {
        let line = self.starts.partition_point(|start| *start <= offset).max(1);
        let start = self.starts.get(line - 1).copied().unwrap_or_default();

        Position {
            column: self.offsets.utf16(offset) - self.offsets.utf16(start),
            line: u32::try_from(line).unwrap_or(u32::MAX),
        }
    }
}

/// The position just after `source`'s prefix up to `offset`, counted as the TypeScript compiler
/// splits the prefix into lines.
fn end_of(source: &str, offset: u32) -> Position {
    let prefix = source.get(..offset as usize).unwrap_or(source);
    let line = memchr::memchr_iter(b'\n', prefix.as_bytes()).count() + 1;
    let last = prefix.rsplit('\n').next().unwrap_or_default();

    Position {
        column: u32::try_from(js::utf16_len(last)).unwrap_or(u32::MAX),
        line: u32::try_from(line).unwrap_or(u32::MAX),
    }
}

fn utf16_column(text: &str, byte: usize) -> u32 {
    u32::try_from(js::utf16_len(text.get(..byte).unwrap_or(text))).unwrap_or(u32::MAX)
}

/// Compiles one module's web output.
///
/// `units` names shared atomic rules across a graph. Without it, the module gets its own scope.
///
/// # Errors
///
/// Returns plain errors for CSS-only modules without explicit ids, and `Css.CompileError` from
/// emission.
pub fn compile<'a>(
    options: &Options<'_, 'a>,
    extracted: &Extracted<'a>,
    parsed: &Parsed<'a>,
    units: Option<&mut Units<'_>>,
) -> Result<Output> {
    let portable = !options.compiler;
    let module_id = options.module_id;
    let source = options.source;
    let typed = typed(module_id);
    let mut portable_names: FxHashMap<Arc<str>, Arc<str>> = FxHashMap::default();

    if portable {
        check_portable(extracted, &mut portable_names)?;
    }

    let mut module = Edits::new(source);
    let program = parsed.program;

    for call in &extracted.contribution_calls {
        module.overwrite(call.start, call.end, contribution_text(call, typed))?;
    }

    let calls_by_start: FxHashMap<u32, &Call<'a>> = extracted
        .calls
        .iter()
        .map(|call| (call.start, call))
        .collect();
    // Modules import few bindings, so a list beats hashing every identifier.
    let imports: SmallVec<[&str; 8]> = program
        .body
        .iter()
        .filter_map(|statement| match statement {
            Statement::ImportDeclaration(import) => import.specifiers.as_ref(),
            _ => None,
        })
        .flatten()
        .map(|specifier| specifier.local().name.as_str())
        .collect();
    let mut walker = Walker {
        applications: FxHashMap::default(),
        calls: &calls_by_start,
        definitions: FxHashMap::default(),
        identifiers: FxHashMap::default(),
        imports,
        unused_selections: FxHashSet::default(),
    };

    walker.scan(&parsed.semantic);

    let local_applications = applications::create(
        program,
        &parsed.semantic,
        &extracted.calls,
        applications::Options::default(),
    );
    let found: Vec<&Application> = local_applications
        .iter()
        .flat_map(applications::Applications::find)
        .collect();
    // Compositions supersede their inputs' classes, so those reads stay unfolded.
    let compositions_intervals = Intervals::new(
        extracted
            .calls
            .iter()
            .filter(|call| call.composition.is_some() || call.runtime_composition.is_some())
            .map(|call| (call.start, call.end))
            .collect(),
    );
    let composing_span = |start: u32, end: u32| compositions_intervals.contains(start, end);
    let composing = |application: &Application| composing_span(application.start, application.end);
    let html_starts: FxHashSet<u32> = extracted
        .calls
        .iter()
        .filter(|call| call.output == Some(ThemeOutput::Html))
        .flat_map(|call| {
            call.runtime_composition
                .iter()
                .flatten()
                .filter_map(|input| input.application_start)
        })
        .collect();
    // The first call of each definition decides its output, as a search in source order would.
    // Without HTML output every application reads `className`.
    let mut outputs: FxHashMap<&str, bool> = FxHashMap::default();

    if extracted
        .calls
        .iter()
        .any(|call| call.output == Some(ThemeOutput::Html))
    {
        for call in &extracted.calls {
            if !outputs.contains_key(&*call.name) {
                outputs.insert(&call.name, call.output == Some(ThemeOutput::Html));
            }
        }
    }

    // An override folds when its value can follow an initialization guard, and when no
    // rewritten name inside it would need a second copy.
    let foldable_override = |application: &Application| {
        application.class_override.is_none_or(|value| {
            !outputs.get(&*application.name).copied().unwrap_or_default()
                && (application.initialized
                    || (value.simple
                        && source
                            .get(value.start as usize..value.end as usize)
                            .unwrap_or_default()
                            .split('.')
                            .all(|name| !walker.identifiers.contains_key(name.trim()))))
        })
    };
    let folded: Vec<&Application> = found
        .iter()
        .copied()
        .filter(|application| {
            !composing(application)
                && !html_starts.contains(&application.start)
                && foldable_override(application)
        })
        .collect();
    let folded_starts: FxHashSet<u32> =
        folded.iter().map(|application| application.start).collect();
    let local = if portable || options.development {
        None
    } else {
        local_applications
            .as_ref()
            .map(applications::Applications::definitions)
    };
    // Styles applied only alone to DOM elements, or inside cx, never meet another style's
    // classes, so atomic ones share rules like independent styles.
    let mut combined: FxHashSet<&str> =
        FxHashSet::with_capacity_and_hasher(found.len(), FxBuildHasher);

    combined.extend(
        found
            .iter()
            .filter(|application| !application.terminal && !composing(application))
            .map(|application| &*application.name),
    );

    let standalone: FxHashSet<Arc<str>> = local
        .iter()
        .flat_map(|local| local.values.keys())
        .filter(|name| !combined.contains(&***name))
        .cloned()
        .collect();
    let schemes = options.schemes.unwrap_or(
        !extracted.theme_appearances.is_empty()
            || !extracted.theme_scripts.is_empty()
            || !extracted.theme_selections.is_empty(),
    );
    let styles: Vec<Arc<NamedStyle>> = if portable || options.development {
        extracted.styles.styles.clone()
    } else {
        let dead = local_applications
            .as_ref()
            .map(applications::Applications::dead)
            .unwrap_or_default();

        if dead.is_empty() && standalone.is_empty() {
            extracted.styles.styles.clone()
        } else {
            extracted
                .styles
                .styles
                .iter()
                .map(|style| {
                    if dead.contains(&style.name) {
                        return Arc::new(NamedStyle {
                            css_output: style.css_output,
                            declarations: Vec::new(),
                            name: Arc::clone(&style.name),
                            ..NamedStyle::default()
                        });
                    }

                    // Grouped output keeps one class per style.
                    let atomic = style
                        .css_output
                        .or(options.css_output)
                        .unwrap_or(CssOutput::Atomic)
                        == CssOutput::Atomic;

                    if standalone.contains(&style.name) && atomic {
                        Arc::new(NamedStyle {
                            composition: Some(Composition::Independent),
                            ..(**style).clone()
                        })
                    } else {
                        Arc::clone(style)
                    }
                })
                .collect()
        }
    };
    let vars: Vec<(Arc<str>, Scope)> = extracted
        .vars
        .iter()
        .map(|(name, theme)| (Arc::clone(name), Scope::Definition(theme.metadata.clone())))
        .collect();
    let names: css::Names = portable_names
        .iter()
        .map(|(name, class)| (Arc::clone(name), Arc::clone(class)))
        .collect();
    if options.invalid_css_output {
        return Err(css::invalid_output(vec![Arc::from("cssOutput")]));
    }

    let css_options = css::Options {
        composition: options.composition,
        contributions: &extracted.contributions,
        contributions_only: false,
        css_output: options.css_output,
        deferred_scopes: options.deferred_scopes,
        development: options.development,
        labels: extracted.styles.labels.as_deref(),
        names: portable.then_some(&names),
        schemes,
        scope: None,
        shared: options.shared,
        styles: &styles,
        vars: (!vars.is_empty()).then_some(vars.as_slice()),
    };
    let mut emitted = if let Some(units) = units {
        css::compile(&css_options, Some(units))?
    } else {
        let mut registry = Registry::new();
        let qualifier = identity::compact(module_id);
        let qualifier = &qualifier[qualifier.len().saturating_sub(6)..];
        let mut units = registry.scope(module_id, qualifier, Visibility::All);

        css::compile(&css_options, Some(&mut units))?
    };
    let classes = classes(
        extracted,
        &mut emitted,
        portable,
        &portable_names,
        options.referenced,
    );
    let generator = Generator {
        classes,
        shadowed: parsed
            .semantic
            .scoping()
            .symbol_names()
            .any(|name| name == "Object" || name == "String"),
        owners: options.owners,
        style_classes: options.style_classes,
        emitted: &emitted,
        extracted,
        identifiers: &walker.identifiers,
        parsed,
        typed,
    };
    let mut state =
        generator.rewrite(&mut module, &walker, local.as_ref(), &found, &folded_starts)?;

    for application in &folded {
        let class_name = json_class(&generator.classes, &application.name);
        let html = outputs.get(&*application.name).copied().unwrap_or_default();
        let key = if html { "class" } else { "className" };
        let callee = source
            .get(application.start as usize..application.callee_end as usize)
            .unwrap_or_default();
        // A read of the folded object's own key, or a JSX spread of the object, needs only the
        // class list.
        let read = application
            .class_read
            .filter(|read| read.html == html)
            .map(|read| read.end);
        let spread = application.spread;

        match (application.class_override, application.initialized) {
            (None, true) => {
                if let Some(end) = read {
                    module.overwrite(application.start, end, class_name)?;
                } else if let Some(spread) = spread {
                    module.overwrite(
                        spread.start,
                        spread.end,
                        format!("{key}={{{class_name}}}"),
                    )?;
                } else {
                    module.overwrite(
                        application.start,
                        application.end,
                        format!("({{{key}:{class_name}}})"),
                    )?;
                }
            }
            // Keep a callable guard so bundlers also keep failures before initialization.
            (None, false) => {
                let guarded = format!("({callee}?{class_name}:{callee}().{key})");

                if let Some(end) = read {
                    module.overwrite(application.start, end, guarded)?;
                } else if let Some(spread) = spread {
                    module.overwrite(spread.start, spread.end, format!("{key}={{{guarded}}}"))?;
                } else {
                    module.overwrite(
                        application.start,
                        application.end,
                        format!("({callee}?{{{key}:{class_name}}}:{callee}())"),
                    )?;
                }
            }
            // The value stays in place, so rewrites inside it still apply.
            (Some(value), true) => {
                let open = format!("{}.merge({class_name},", state.runtime);

                state.callable = true;

                if let Some(end) = read {
                    module.overwrite(application.start, value.start, open)?;
                    module.overwrite(value.end, end, ")")?;
                } else if let Some(spread) = spread {
                    module.overwrite(spread.start, value.start, format!("{key}={{{open}"))?;
                    module.overwrite(value.end, spread.end, ")}")?;
                } else {
                    module.overwrite(application.start, value.start, format!("({{{key}:{open}"))?;
                    module.overwrite(value.end, application.end, ")})")?;
                }
            }
            // A simple value reads the same in both branches of the guard.
            (Some(value), false) => {
                let text = source
                    .get(value.start as usize..value.end as usize)
                    .unwrap_or_default();
                let merged = format!("{}.merge({class_name},{text})", state.runtime);
                let fallback = format!("{callee}({{className:{text}}})");

                state.callable = true;

                if let Some(end) = read {
                    module.overwrite(
                        application.start,
                        end,
                        format!("({callee}?{merged}:{fallback}.{key})"),
                    )?;
                } else if let Some(spread) = spread {
                    module.overwrite(
                        spread.start,
                        spread.end,
                        format!("{key}={{{callee}?{merged}:{fallback}.{key}}}"),
                    )?;
                } else {
                    module.overwrite(
                        application.start,
                        application.end,
                        format!("({callee}?{{{key}:{merged}}}:{fallback})"),
                    )?;
                }
            }
        }
    }

    let bound = local_applications
        .as_ref()
        .map(applications::Applications::bound)
        .unwrap_or_default();

    let named: FxHashMap<&str, &NamedStyle> = if bound.is_empty() {
        FxHashMap::default()
    } else {
        styles
            .iter()
            .map(|style| (&*style.name, &**style))
            .collect()
    };

    for call in &extracted.calls {
        let (Some(slots), Some(applied)) = (&call.slots, bound.get(&call.name)) else {
            continue;
        };

        if outputs.get(&*call.name).copied().unwrap_or_default() {
            continue;
        }

        let Some(style) = named.get(&*call.name) else {
            continue;
        };
        let properties = dynamic::inline(style, slots, &call.keywords);

        if properties.is_empty() {
            continue;
        }

        let class_name = json_class(&generator.classes, &call.name);

        for application in applied {
            if composing_span(application.start, application.end)
                || html_starts.contains(&application.start)
            {
                continue;
            }

            fold_bound(
                &mut module,
                source,
                application,
                slots,
                &properties,
                &class_name,
            )?;
        }
    }

    generator.themes(&mut module, &walker, &mut state)?;
    generator.aliases(&mut module)?;
    generator.imports(&mut module, &walker, program)?;
    generator.runtime_import(&mut module, program, &state)?;

    let lines = Lines::new(source, &parsed.offsets);
    let (css, css_map) = generator.css(
        &walker.definitions,
        &lines,
        module_id,
        (!vars.is_empty()).then_some(vars.as_slice()),
    )?;
    // The module map writes its content from the source, so the map holds no copy.
    let map_options = MapOptions {
        hires: true,
        include_content: false,
        source: Some(module_id),
    };
    let (code, map) = if portable {
        (
            source.to_owned(),
            MagicString::new(source).generate_map(&map_options),
        )
    } else {
        module.finish(&map_options)
    };
    let (css, css_map) = rewrite_namespaces(&css, &extracted.namespaces, css_map)?;
    let classes = generator.classes;
    let css::Output {
        references,
        rules,
        shared,
        units,
        vars,
        ..
    } = emitted;

    Ok(Output {
        classes,
        code,
        css,
        css_map,
        map: write_module_map(&map, module_id, source, options.placeholder),
        references,
        rules,
        shared,
        units,
        vars,
    })
}

/// `{ file, mappings, names, sources, sourcesContent, version }`, the module map's key order.
/// Content equal to `placeholder` is written as `0`.
fn write_module_map(
    map: &crate::mapping::magic_string::SourceMap,
    module_id: &str,
    source: &str,
    placeholder: Option<&str>,
) -> String {
    let content = if placeholder == Some(source) {
        0
    } else {
        source.len()
    };
    let mut output =
        String::with_capacity(map.mappings.len() + module_id.len() * 2 + content + 128);

    output.push_str("{\"file\":");
    js::write_string(&mut output, module_id);
    output.push_str(",\"mappings\":");
    js::write_mappings(&mut output, &map.mappings);
    output.push_str(",\"names\":[");

    for (index, name) in map.names.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }

        js::write_string(&mut output, name);
    }

    output.push_str("],\"sources\":[");

    for (index, source) in map.sources.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }

        js::write_string(&mut output, source);
    }

    output.push_str("],\"sourcesContent\":");
    // The map's one source is the module, whose content is written from the borrowed text.
    crate::mapping::gen_mapping::write_contents(
        &mut output,
        [Some(source)].into_iter(),
        placeholder,
    );
    output.push_str(",\"version\":3}");
    output
}

/// Rewrites namespace-sensitive selectors with declarations, composing the CSS map. Modules
/// without namespaces keep their CSS and map.
fn rewrite_namespaces(
    css: &str,
    namespaces: &[crate::web::internal::namespace::Definition],
    map: EncodedSourceMap,
) -> Result<(String, EncodedSourceMap)> {
    if namespaces.is_empty() || css.is_empty() {
        return Ok((css.to_owned(), map));
    }

    let (css, rewritten) =
        crate::compiler::internal::namespaces::rewrite(css, namespaces, Some(&map), true)?;

    Ok((css, rewritten.unwrap_or(map)))
}

fn check_portable(
    extracted: &Extracted<'_>,
    portable_names: &mut FxHashMap<Arc<str>, Arc<str>>,
) -> Result<()> {
    for call in &extracted.calls {
        let Some(portable) = &call.portable else {
            return Err(message(
                "CSS-only output requires an explicit id for dynamic styles, variants, and compositions.",
            ));
        };

        portable_names.insert(Arc::clone(&call.name), Arc::clone(portable));
    }

    for (name, theme) in extracted.vars.iter() {
        let themed = !theme.metadata.values.is_empty()
            || extracted.theme_calls.iter().any(|call| {
                (call.name == *name
                    || call
                        .members
                        .iter()
                        .flat_map(js::Record::values)
                        .any(|member| member == name))
                    && call
                        .options
                        .as_ref()
                        .is_none_or(|options| options.has("themes") || options.has("theme"))
            });
        let explicit = theme
            .metadata
            .contract
            .identity
            .as_deref()
            .is_some_and(|identity| identity.starts_with("id-"));

        if themed && !explicit {
            return Err(message(
                "CSS-only themes require an explicit id on Config.create or Vars.define.",
            ));
        }
    }

    for call in &extracted.contribution_calls {
        if let Some(name) = &call.name
            && !explicit_contribution(name)
        {
            return Err(message(
                "CSS-only named stylesheet declarations require an explicit id.",
            ));
        }
    }

    if extracted.variable_calls.iter().any(|call| !call.explicit) {
        return Err(message("CSS-only output requires an explicit variable id."));
    }

    for style in &extracted.styles.styles {
        portable_selectors(style)?;
    }

    Ok(())
}

fn portable_selectors(style: &NamedStyle) -> Result<()> {
    for rule in style.rules.iter().flatten() {
        if let Some(condition) = &rule.condition
            && !condition.starts_with('@')
            && style_reference_without_id(condition)
        {
            return Err(message(
                "CSS-only selector references require an explicit style id.",
            ));
        }

        portable_selectors(&rule.style)?;
    }

    Ok(())
}

/// Matches `^(?:--)?z-(?:k|counterstyle|positiontry|colorprofile|fontpalettevalues|custommedia|cssfunction)id-`.
fn explicit_contribution(name: &str) -> bool {
    let name = name.strip_prefix("--").unwrap_or(name);
    let Some(rest) = name.strip_prefix("z-") else {
        return false;
    };

    [
        "k",
        "counterstyle",
        "positiontry",
        "colorprofile",
        "fontpalettevalues",
        "custommedia",
        "cssfunction",
    ]
    .iter()
    .any(|kind| {
        rest.strip_prefix(kind)
            .is_some_and(|rest| rest.starts_with("id-"))
    })
}

/// Matches `/\.z-style-(?!id-)/`.
fn style_reference_without_id(condition: &str) -> bool {
    condition
        .match_indices(".z-style-")
        .any(|(index, matched)| !condition[index + matched.len()..].starts_with("id-"))
}

fn contribution_text(
    call: &crate::compiler::internal::contributions::Call<'_>,
    typed: bool,
) -> String {
    let name = call.name.as_deref().unwrap_or_default();

    match call.kind {
        Factory::CssFunction => {
            let parameters = call.function.as_ref().map_or_else(
                || "[]".to_owned(),
                |function| {
                    let mut output = String::from("[");

                    for (index, parameter) in function.parameters.iter().enumerate() {
                        if index > 0 {
                            output.push(',');
                        }

                        themes::write_parameter(&mut output, parameter);
                    }

                    output.push(']');
                    output
                },
            );
            let returns = quote(
                call.function
                    .as_ref()
                    .map_or("*", |function| &function.returns),
            );
            let parameter = if typed {
                ": readonly (string | number)[]"
            } else {
                ""
            };
            let cast = if typed {
                format!(" as import('zyzz/web').cssFunction.Reference<{parameters}, {returns}>")
            } else {
                String::new()
            };

            format!(
                "((...args{parameter}) => {} + args.map(value => typeof value === 'string' && value.includes(',') && !value.trimStart().startsWith('{{') ? '{{' + value + '}}' : value).join(',') + ')'){cast}",
                quote(&format!("{name}("))
            )
        }
        Factory::CustomMedia => format!(
            "{}{}",
            quote(&format!("@media ({name})")),
            if typed {
                " as unknown as import('zyzz/web').customMedia.Reference"
            } else {
                ""
            }
        ),
        _ if call.name.is_none() => "void 0".to_owned(),
        kind => {
            let cast = if matches!(kind, Factory::Keyframes) || !typed {
                String::new()
            } else {
                format!(" as import('zyzz/web').{}.Reference", kind.as_str())
            };

            format!("{}{cast}", quote(name))
        }
    }
}

/// The module's class lists. Lists that need no identities move out of `emitted`, which keeps
/// them otherwise.
fn classes(
    extracted: &Extracted<'_>,
    emitted: &mut css::Output,
    portable: bool,
    portable_names: &FxHashMap<Arc<str>, Arc<str>>,
    referenced: Option<&FxHashSet<Arc<str>>>,
) -> IndexMap<Arc<str>, String, FxBuildHasher> {
    let identities: FxHashMap<&str, &str> = extracted
        .calls
        .iter()
        .filter_map(|call| {
            call.identity
                .as_deref()
                .filter(|identity| !identity.is_empty())
                .map(|identity| (&*call.name, identity))
        })
        .collect();

    // Emitted lists already hold distinct names, so only identities can change them.
    if emitted.plain && identities.is_empty() {
        return std::mem::take(&mut emitted.classes);
    }

    emitted
        .classes
        .iter()
        .map(|(name, value)| {
            let extra = identities.get(&**name).filter(|_| {
                !portable
                    || portable_names
                        .get(name)
                        .is_some_and(|portable| portable.starts_with("z-compose-"))
            });
            let extra: Option<Cow<'_, str>> = extra.map(|identity| {
                if portable {
                    Cow::Owned(
                        identity
                            .split(' ')
                            .filter(|name| name.starts_with("z-style-id-"))
                            .collect::<Vec<_>>()
                            .join(" "),
                    )
                } else if let Some(referenced) = referenced {
                    // Only selectors match identity classes, and a complete graph holds them all.
                    Cow::Owned(
                        identity
                            .split(' ')
                            .filter(|name| {
                                name.starts_with("z-style-id-") || referenced.contains(*name)
                            })
                            .collect::<Vec<_>>()
                            .join(" "),
                    )
                } else {
                    Cow::Borrowed(*identity)
                }
            });
            let mut list: SmallVec<[&str; 16]> = SmallVec::new();

            for class in value.split(' ').filter(|class| !class.is_empty()) {
                if !list.contains(&class) {
                    list.push(class);
                }
            }

            if let Some(extra) = &extra
                && !extra.is_empty()
                && !list.contains(&&**extra)
            {
                list.push(extra);
            }

            let mut joined = String::with_capacity(
                value.len() + extra.as_ref().map_or(0, |extra| extra.len() + 1),
            );

            for (index, class) in list.iter().enumerate() {
                if index > 0 {
                    joined.push(' ');
                }

                joined.push_str(class);
            }

            (Arc::clone(name), joined)
        })
        .collect()
}

/// Marks the HTML styles that linked HTML compositions read, so they bind composition helpers.
fn prepare(link: &themes::Link, calls: &[Call<'_>], prepared: &mut FxHashSet<Arc<str>>) {
    if link
        .style
        .as_ref()
        .is_some_and(|style| style.output == Some(ThemeOutput::Html))
        && let Some(call) = calls
            .iter()
            .find(|call| call.identity.as_deref() == Some(&*link.binding))
    {
        prepared.insert(Arc::clone(&call.name));
    }

    for member in link.members.iter().flat_map(js::Record::values) {
        prepare(member, calls, prepared);
    }
}

/// Which runtime helpers the rewritten module imports.
#[derive(Default)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "Each flag selects one independent runtime import."
)]
struct State {
    appearance: String,
    callable: bool,
    composition: String,
    composition_arguments: FxHashMap<(u32, u32), String>,
    composition_html: String,
    compositions: Vec<String>,
    conditional_recipe: String,
    html: String,
    payload_recipe: String,
    recipe: String,
    runtime: String,
    selection: String,
    uses_appearance: bool,
    uses_composition: bool,
    uses_composition_html: bool,
    uses_conditional_recipe: bool,
    uses_html: bool,
    uses_payload_recipe: bool,
    uses_recipe: bool,
    uses_selection: bool,
    variables: String,
}

struct Generator<'g, 'a> {
    classes: IndexMap<Arc<str>, String, FxBuildHasher>,
    /// Whether a module binding renames `Object` or `String`, which specialized selectors read.
    shadowed: bool,
    owners: Option<&'g Owners>,
    style_classes: Option<&'g FxHashMap<Arc<str>, Arc<str>>>,
    emitted: &'g css::Output,
    extracted: &'g Extracted<'a>,
    identifiers: &'g FxHashMap<&'a str, Vec<Span>>,
    parsed: &'g Parsed<'a>,
    typed: bool,
}

impl<'a> Generator<'_, 'a> {
    fn class(&self, name: &str) -> String {
        json_class(&self.classes, name)
    }

    /// The generated class list that applications of a composed definition carry.
    fn input_class(&self, name: &str) -> Option<&str> {
        self.classes.get(name).map(String::as_str).or_else(|| {
            self.style_classes
                .and_then(|classes| classes.get(name))
                .map(|class| &**class)
        })
    }

    /// Replaces a known application with its callee read, which still throws before
    /// initialization, followed by `value`. Conditions keep their authored evaluation.
    fn known_argument(
        &self,
        module: &mut Edits<'a>,
        known: &KnownInput,
        value: &str,
        mask: bool,
    ) -> String {
        let callee = &known.callee;
        let cast = if self.typed { " as unknown" } else { "" };
        let read = format!("(({callee}{cast})||{callee}(),{value})");
        let Some(condition) = known.condition else {
            return read;
        };
        let left = module
            .slice(condition.start, condition.end)
            .unwrap_or_else(|_| {
                self.parsed
                    .source
                    .get(condition.start as usize..condition.end as usize)
                    .unwrap_or_default()
                    .to_owned()
            });

        if mask {
            format!("(({left})?{read}:0)")
        } else {
            format!("({left})&&{read}")
        }
    }

    /// Selects one of the precompiled presence alternatives from a hoisted table of frozen props,
    /// indexed by the presence mask of the conditional arguments.
    fn constant(
        &self,
        module: &mut Edits<'a>,
        state: &mut State,
        call: &Call<'a>,
        inputs: &[RuntimeInput],
        known: &[Option<&KnownInput>],
        factory: &str,
    ) -> String {
        let names: Vec<&str> = match &call.composition_cases {
            Some(cases) => cases.iter().map(|name| &**name).collect(),
            None => vec![&*call.name],
        };
        let mut table = String::from("[");

        for (index, name) in names.iter().enumerate() {
            if index > 0 {
                table.push(',');
            }

            table.push_str("{className:");
            js::write_string(
                &mut table,
                self.classes.get(*name).map_or("", String::as_str),
            );
            table.push('}');
        }

        table.push(']');
        state.compositions.push(format!(
            "const {factory}=/*#__PURE__*/{table}.map(Object.freeze);"
        ));

        let terms: Vec<String> = inputs
            .iter()
            .zip(known)
            .filter_map(|(input, known)| {
                let value = input.condition.map_or_else(
                    || "0".to_owned(),
                    |condition| (1_u32 << condition).to_string(),
                );

                Some(self.known_argument(module, (*known)?, &value, true))
            })
            .collect();

        format!("{factory}[{}]", terms.join("|"))
    }

    /// Binds a runtime composition helper to the precompiled presence alternatives and the
    /// ownership that inputs with overrides, recipes, or bindings replace.
    #[expect(
        clippy::too_many_arguments,
        reason = "The composition rewrite shares the module's edit state."
    )]
    fn runtime_composition(
        &self,
        module: &mut Edits<'a>,
        state: &mut State,
        call: &Call<'a>,
        inputs: &[RuntimeInput],
        known: &[Option<&KnownInput>],
        factory: &str,
        html: bool,
    ) -> String {
        let helper = if html {
            state.uses_composition_html = true;
            state.composition_html.clone()
        } else {
            state.uses_composition = true;
            state.composition.clone()
        };
        let mut config = String::from("{");

        match &call.composition_cases {
            Some(cases) => {
                config.push_str("\"cases\":[");

                for (index, name) in cases.iter().enumerate() {
                    if index > 0 {
                        config.push(',');
                    }

                    // An array prints a missing class list as `null`.
                    match self.classes.get(name) {
                        Some(class) => js::write_string(&mut config, class),
                        None => config.push_str("null"),
                    }
                }

                config.push_str("],");
            }
            // The last presence alternative is the complete class list, so only a call without
            // conditions carries it separately. `JSON.stringify` omits a missing class list.
            None => {
                if let Some(class) = self.classes.get(&call.name) {
                    config.push_str("\"className\":");
                    js::write_string(&mut config, class);
                    config.push(',');
                }
            }
        }

        config.push_str("\"inputs\":[");

        for (index, (input, known)) in inputs.iter().zip(known).enumerate() {
            if index > 0 {
                config.push(',');
            }

            let mut fields: Vec<String> = Vec::new();

            // Known inputs pass `true`, so the helper never reads their class list.
            if known.is_none() {
                let mut field = String::from("\"className\":");

                js::write_string(
                    &mut field,
                    self.input_class(&input.name).unwrap_or_default(),
                );
                fields.push(field);
            }

            if let Some(condition) = input.condition {
                fields.push(format!("\"condition\":{condition}"));
            }

            for (key, values) in [
                (
                    "attributes",
                    input
                        .owners
                        .iter()
                        .flat_map(|owner| owner.attributes.iter())
                        .collect::<Vec<_>>(),
                ),
                (
                    "slots",
                    input
                        .owners
                        .iter()
                        .flat_map(|owner| owner.slots.iter())
                        .collect::<Vec<_>>(),
                ),
            ] {
                if values.is_empty() {
                    continue;
                }

                let mut field = format!("\"{key}\":[");

                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        field.push(',');
                    }

                    js::write_string(&mut field, value);
                }

                field.push(']');
                fields.push(field);
            }

            config.push('{');
            config.push_str(&fields.join(","));
            config.push('}');
        }

        config.push_str("]}");
        state.compositions.push(format!(
            "const {factory}=/*#__PURE__*/{helper}.create({config});"
        ));

        let arguments: Vec<String> = inputs
            .iter()
            .zip(known)
            .map(|(input, known)| match known {
                Some(known) => self.known_argument(module, known, "!0", false),
                None => state
                    .composition_arguments
                    .get(&(input.start, input.end))
                    .cloned()
                    .unwrap_or_default(),
            })
            .collect();

        format!("{factory}({})", arguments.join(","))
    }

    fn rewrite(
        &self,
        module: &mut Edits<'a>,
        walker: &Walker<'_, 'a>,
        local: Option<&applications::Definitions>,
        found: &[&Application],
        folded: &FxHashSet<u32>,
    ) -> Result<State> {
        let extracted = self.extracted;
        let identifiers = self.identifiers;
        let typed = self.typed;
        let mut state = State {
            appearance: unique(identifiers, "__zyzzAppearance"),
            composition: unique(identifiers, "__zyzzComposition"),
            composition_html: unique(identifiers, "__zyzzCompositionHtml"),
            conditional_recipe: unique(identifiers, "__zyzzConditionalRecipe"),
            html: unique(identifiers, "__zyzzHtml"),
            payload_recipe: unique(identifiers, "__zyzzPayloadRecipe"),
            recipe: unique(identifiers, "__zyzzRecipe"),
            runtime: unique(identifiers, "__zyzzProps"),
            selection: unique(identifiers, "__zyzzSelection"),
            variables: unique(identifiers, "__zyzzVariable"),
            ..State::default()
        };
        let mut prepared_html: FxHashSet<Arc<str>> = extracted
            .calls
            .iter()
            .filter(|call| call.output == Some(ThemeOutput::Html))
            .flat_map(|call| {
                call.runtime_composition
                    .iter()
                    .flatten()
                    .map(|input| Arc::clone(&input.name))
            })
            .collect();

        for link in extracted.theme_exports.iter().flat_map(js::Record::values) {
            prepare(link, &extracted.calls, &mut prepared_html);
        }

        for call in &extracted.variable_calls {
            let mut slot = String::new();

            match call.slots.get("value") {
                Some(binding) => packed_styles::encode_binding(&mut slot, binding),
                None => slot.push_str("undefined"),
            }

            module.overwrite(
                call.start,
                call.end,
                format!("{}.create({slot})", state.variables),
            )?;
        }

        // Definitions read only through folded applications need no class list of their own. True
        // marks definitions whose every read follows initialization.
        let read: FxHashSet<&str> = found
            .iter()
            .filter(|application| !folded.contains(&application.start))
            .map(|application| &*application.name)
            .collect();
        let mut unread: FxHashMap<&str, bool> = FxHashMap::with_capacity_and_hasher(
            local.as_ref().map_or(0, |local| local.values.len()),
            FxBuildHasher,
        );

        unread.extend(
            local
                .iter()
                .flat_map(|local| local.values.iter())
                .filter(|(name, _)| !read.contains(&***name))
                .map(|(name, initialized)| (&**name, *initialized)),
        );

        let namespaces: Vec<&applications::Namespace> = local
            .iter()
            .flat_map(|local| local.namespaces.iter())
            .filter(|namespace| {
                namespace
                    .ends
                    .keys()
                    .all(|name| unread.get(&**name).copied().unwrap_or_default())
            })
            .collect();
        let mut erased: FxHashMap<&str, u32> = FxHashMap::with_capacity_and_hasher(
            namespaces
                .iter()
                .map(|namespace| namespace.ends.len())
                .sum(),
            FxBuildHasher,
        );

        erased.extend(
            namespaces
                .iter()
                .flat_map(|namespace| namespace.ends.iter().map(|(name, end)| (&**name, *end))),
        );

        // An ambient namespace keeps member types without runtime initialization. A namespace no
        // type names has nothing left to declare, so it is removed with its members.
        let removed: FxHashSet<&str> = namespaces
            .iter()
            .filter(|namespace| !namespace.typed)
            .flat_map(|namespace| namespace.ends.keys().map(|name| &**name))
            .collect();

        for namespace in &namespaces {
            if namespace.typed {
                module.prepend_right(namespace.start, "declare ")?;
            } else {
                module.remove(namespace.start, namespace.end)?;
            }
        }

        for call in &extracted.calls {
            if let Some(end) = erased.get(&*call.name)
                && !removed.contains(&*call.name)
            {
                let annotation = if call.output == Some(ThemeOutput::Html) {
                    ": import('zyzz').style.ReturnType<'html'>"
                } else {
                    ": import('zyzz').style.ReturnType"
                };

                module.overwrite(*end, call.start, annotation)?;
            }
        }

        let composed = Intervals::new(
            extracted
                .calls
                .iter()
                .filter(|call| call.composition.is_some())
                .map(|call| (call.start, call.end))
                .collect(),
        );
        let mut rewrites: Vec<&Call<'a>> = extracted.calls.iter().collect();

        // Rewrite contained expressions before the enclosing composition reads them. Contained
        // calls end before the calls that contain them.
        rewrites.sort_by_key(|call| call.end);

        for call in rewrites {
            if call.composition_case || composed.contains(call.start, call.end) {
                continue;
            }

            let Some(application) = walker.applications.get(&call.start).copied() else {
                continue;
            };
            let html = call.output == Some(ThemeOutput::Html);
            let key = if html { "class" } else { "className" };
            // Unread definitions hold no composition, recipe, or slots, and their replacement
            // reads no class list.
            let (class_name, props) = if unread.contains_key(&*call.name) {
                (String::new(), String::new())
            } else {
                let class_name = self.class(&call.name);
                let mut props = String::with_capacity(key.len() + class_name.len() + 3);

                props.push('{');
                props.push_str(key);
                props.push(':');
                props.push_str(&class_name);
                props.push('}');
                (class_name, props)
            };
            let compose_html = html && prepared_html.contains(&call.name);

            if compose_html {
                state.uses_composition_html = true;
            }

            let replacement = if let Some(inputs) = &call.runtime_composition {
                let base = format!("{}{}", state.composition, self.parsed.utf16(call.start));
                let mut factory = base.clone();

                while identifiers.contains_key(factory.as_str()) {
                    factory.push('_');
                }

                // Outer compositions that flatten this call read its authored arguments.
                for input in inputs {
                    state
                        .composition_arguments
                        .entry((input.start, input.end))
                        .or_insert_with(|| {
                            module.slice(input.start, input.end).unwrap_or_default()
                        });
                }

                let known: Vec<Option<&KnownInput>> = inputs
                    .iter()
                    .map(|input| {
                        input.known.as_ref().filter(|known| {
                            !known.imported || self.input_class(&input.name).is_some()
                        })
                    })
                    .collect();

                if !html && known.iter().all(Option::is_some) {
                    self.constant(module, &mut state, call, inputs, &known, &factory)
                } else {
                    self.runtime_composition(
                        module, &mut state, call, inputs, &known, &factory, html,
                    )
                }
            } else if let Some(guards) = &call.composition {
                let base = if compose_html {
                    format!(
                        "{}.from({{className:{class_name}}})",
                        state.composition_html
                    )
                } else {
                    format!("({props})")
                };
                let cast = if typed { " as unknown" } else { "" };

                guards.iter().rev().fold(base, |result, guard| {
                    format!("(({guard}{cast})?{result}:{guard}())")
                })
            } else if let Some(recipe) = &call.recipe {
                let conditional = recipe
                    .conditions
                    .as_ref()
                    .is_some_and(|conditions| !conditions.is_empty());
                let helper = if conditional {
                    state.conditional_recipe.clone()
                } else {
                    state.recipe.clone()
                };

                if conditional {
                    state.uses_conditional_recipe = true;
                }

                let payload = recipe
                    .payloads
                    .as_ref()
                    .is_some_and(|payloads| !payloads.is_empty());

                if payload {
                    state.uses_payload_recipe = true;
                }

                let specialized = !conditional && !payload && !html && !self.shadowed;
                let mut selection = String::new();

                if specialized {
                    write_selector(&mut selection, recipe, &class_name, typed);
                } else {
                    if !conditional {
                        state.uses_recipe = true;
                    }

                    let _ = write!(selection, "/*#__PURE__*/{helper}.create({{\"axes\":");

                    write_axes(&mut selection, recipe);
                    selection.push_str(",\"defaults\":");
                    write_defaults(&mut selection, recipe);

                    if let Some(conditions) = &recipe.conditions {
                        selection.push_str(",\"conditions\":");
                        write_strings(&mut selection, conditions);
                    }

                    if self.classes.contains_key(&call.name) {
                        selection.push_str(",\"className\":");
                        selection.push_str(&class_name);
                    }

                    if !payload && html && !compose_html {
                        selection.push_str(",\"html\":true");
                    }

                    selection.push_str("})");
                }

                let value = if payload {
                    let mut value = format!("{}.create({{...", state.payload_recipe);

                    write_recipe(&mut value, recipe, html && !compose_html);
                    let _ = write!(value, ",select:{selection}}})");
                    value
                } else {
                    selection
                };
                let bound = if compose_html {
                    format!("{}.bind({value})", state.composition_html)
                } else {
                    value
                };
                let axes: Vec<String> = recipe
                    .axes
                    .iter()
                    .map(|(axis, choices)| {
                        let choices: Vec<String> = choices
                            .iter()
                            .map(|choice| {
                                let signature = call
                                    .recipe_types
                                    .as_ref()
                                    .and_then(|types| types.get(axis))
                                    .and_then(|types| types.get(choice));

                                match signature {
                                    Some(signature) if !signature.is_empty() => {
                                        format!("{}:(values:{signature})=>{{}}", quote(choice))
                                    }
                                    _ => format!("{}:{{}}", quote(choice)),
                                }
                            })
                            .collect();

                        format!("{}:{{{}}}", quote(axis), choices.join(";"))
                    })
                    .collect();
                let conditions = recipe.conditions.as_ref().map(|conditions| {
                    conditions
                        .iter()
                        .map(|name| format!("{}:unknown", quote(name)))
                        .collect::<Vec<_>>()
                        .join(";")
                });
                let conditions = match conditions {
                    Some(conditions) if !conditions.is_empty() => {
                        format!(";conditions:{{{conditions}}}")
                    }
                    _ => String::new(),
                };
                let output = if html { ",\"html\"" } else { "" };
                let kind = format!(
                    "import('zyzz').variants.ReturnType<{{variants:{{{}}}{conditions}}}{output}>",
                    axes.join(";")
                );

                // A specialized selector returns plain records, which assert through unknown.
                let cast = if specialized { " as unknown" } else { "" };

                if typed {
                    format!("({bound}{cast} as {kind})")
                } else {
                    bound
                }
            } else if let Some(slots) = &call.slots {
                let output = if html { ",\"html\"" } else { "" };
                let kind = format!(
                    "import('zyzz').style.Dynamic<{}{output}>",
                    call.values_type.as_deref().unwrap_or_default()
                );
                let mut reads = String::new();

                for (index, key) in slots.keys().enumerate() {
                    let _ = write!(
                        reads,
                        "const v{index}=input[{}]{};",
                        quote(key),
                        if typed { " as string | number" } else { "" }
                    );
                }

                let assignments = slots
                    .values()
                    .enumerate()
                    .map(|(index, slot)| {
                        format!("{}:v{index}===''?' ':v{index}", quote(&slot.name))
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                let parameter = if typed {
                    format!(":Parameters<{kind}>[0]")
                } else {
                    String::new()
                };
                let value = format!(
                    "(input{parameter})=>{{{reads}const external=input.className;const style=input.style;return {{className:external?{class_name}+\" \"+external:{class_name},style:{{...input.vars,...style,{assignments}}}}}}}"
                );
                let result = if compose_html {
                    format!("{}.bind({value})", state.composition_html)
                } else if html {
                    format!("{}.bind({value})", state.html)
                } else {
                    format!("({value})")
                };

                if html && !compose_html {
                    state.uses_html = true;
                }

                if typed {
                    format!("({result} as {kind})")
                } else {
                    result
                }
            } else if let Some(initialized) = unread.get(&*call.name) {
                if erased.contains_key(&*call.name) {
                    String::new()
                } else {
                    // Guards read only truthiness, and failures before initialization still call it.
                    let value = if *initialized { "void 0" } else { "1" };
                    let html = if html { "<'html'>" } else { "" };

                    if typed {
                        format!("({value} as unknown as import('zyzz').style.ReturnType{html})")
                    } else {
                        value.to_owned()
                    }
                }
            } else if application.folded {
                if compose_html {
                    format!(
                        "{}.from({{className:{class_name}}})",
                        state.composition_html
                    )
                } else {
                    format!("({props})")
                }
            } else if html {
                if compose_html {
                    state.callable = true;

                    let cast = if typed {
                        " as import('zyzz').style.ReturnType<'html'>"
                    } else {
                        ""
                    };

                    format!(
                        "({}.bind({}.create({{className:{class_name}}})){cast})",
                        state.composition_html, state.runtime
                    )
                } else {
                    state.uses_html = true;
                    format!(
                        "/*#__PURE__*/{}.create({{className:{class_name}}})",
                        state.html
                    )
                }
            } else {
                // Unused definitions then tree-shake, such as those read only in compositions.
                format!("/*#__PURE__*/{}.create({props})", state.runtime)
            };

            if !removed.contains(&*call.name) {
                module.overwrite(call.start, application.end, &replacement)?;
            }

            if call.recipe.is_none()
                && call.slots.is_none()
                && call.runtime_composition.is_none()
                && !application.folded
                && !unread.contains_key(&*call.name)
                && !html
            {
                state.callable = true;
            }
        }

        Ok(state)
    }

    /// Replaces theme and configuration calls with their compiled scope props.
    fn themes(
        &self,
        module: &mut Edits<'a>,
        walker: &Walker<'_, 'a>,
        state: &mut State,
    ) -> Result<()> {
        for call in &self.extracted.theme_calls {
            let props = self.theme_props(call, walker, state);
            let assertion = if self.typed {
                match &call.type_text {
                    Some(text) => format!(" as {text}"),
                    None => format!(" as import('zyzz').Vars.Definition<{}>", call.token_type),
                }
            } else {
                String::new()
            };

            module.overwrite(call.start, call.end, format!("({props}{assertion})"))?;
        }

        Ok(())
    }

    fn theme_props(
        &self,
        call: &themes::Call,
        walker: &Walker<'_, 'a>,
        state: &mut State,
    ) -> String {
        let extracted = self.extracted;
        let vars = &self.emitted.vars;

        if call.variable_set {
            return "{}".to_owned();
        }

        let Some(members) = &call.members else {
            return format!("{{className:{}}}", json_class(vars, &call.name));
        };
        let script = extracted.theme_scripts.contains(&call.name);
        let root = extracted.theme_appearances.contains(&call.name);

        if script || root {
            state.uses_appearance = true;
        }

        let option = |key: &str| {
            call.options
                .as_ref()
                .and_then(|options| options.get(key))
                .cloned()
                .unwrap_or(Data::Undefined)
        };
        // Helpers are emitted only when referenced. Both share the configured storage key.
        let storage = Some(option("storageKey")).filter(truthy);
        let appearance = state.appearance.clone();
        let selection = state.selection.clone();
        let helpers = |entries: &str, default_theme: Option<&str>| {
            let default_theme = default_theme.filter(|theme| !theme.is_empty());
            let mut output = String::new();

            if root {
                let _ = write!(output, "appearance:{appearance}.root({entries}");

                if storage.is_some() || default_theme.is_some() {
                    output.push_str(",{");

                    if let Some(theme) = default_theme {
                        output.push_str("\"defaultVars\":");
                        js::write_string(&mut output, theme);
                    }

                    if let Some(storage) = &storage {
                        if default_theme.is_some() {
                            output.push(',');
                        }

                        output.push_str("\"storageKey\":");
                        js::write_data(&mut output, storage);
                    }

                    output.push('}');
                }

                output.push_str("),");
            }

            if script {
                let _ = write!(output, "script:{appearance}.create({entries}");

                if let Some(storage) = &storage {
                    output.push_str(",{\"storageKey\":");
                    js::write_data(&mut output, storage);
                    output.push('}');
                }

                output.push_str("),");
            }

            output
        };
        let scope = |name: Option<&Arc<str>>| match name.and_then(|name| vars.get(name)) {
            Some(class) => format!("{{\"className\":{}}}", quote(class)),
            None => "{}".to_owned(),
        };
        let themes = truthy(&option("themes"));
        let html = option("output").as_str() == Some("html");

        if call.variable_config {
            let selected = extracted.theme_selections.contains(&call.name)
                || extracted
                    .theme_exports
                    .iter()
                    .flat_map(js::Record::values)
                    .any(|link| {
                        link.call.name == call.name
                            && link.kind == themes::LinkKind::Config
                            && !link.call.initialization
                            && !link.call.root
                    });
            let entries: Vec<(String, Option<&String>)> = if themes {
                members
                    .iter()
                    .filter_map(|(key, name)| {
                        let path = member_path(key)?;

                        (path.len() == 2 && path.first().is_some_and(|first| first == "themes"))
                            .then(|| (path.into_iter().nth(1).unwrap_or_default(), vars.get(name)))
                    })
                    .collect()
            } else {
                vec![("default".to_owned(), vars.get(&call.name))]
            };
            let fallback = match option("defaultTheme") {
                Data::Undefined | Data::Null => Data::string("default"),
                value => value,
            };
            let catalog = if themes {
                write_entries(&entries)
            } else {
                "[]".to_owned()
            };
            let default_theme = themes.then(|| fallback.to_js_string());
            let helpers = helpers(&catalog, default_theme.as_deref());

            if !selected {
                return format!("{{{}}}", helpers.strip_suffix(',').unwrap_or(&helpers));
            }

            state.uses_selection = true;

            let mut fallback_json = String::new();

            js::write_data(&mut fallback_json, &fallback);

            // Rollup drops required selectors when a pure call initializes a destructured object
            // property.
            return format!(
                "{{{helpers}vars:{selection}.create({},{html},'set',{fallback_json})}}",
                write_entries(&entries)
            );
        }

        if themes {
            let mut catalog: js::Record<Option<&String>> = js::Record::new();

            for (key, name) in members.iter() {
                if let Some(mut path) = member_path(key)
                    && path.len() == 2
                {
                    catalog.insert(path.swap_remove(1), vars.get(name));
                }
            }

            let entries: Vec<(String, Option<&String>)> = catalog
                .iter()
                .map(|(key, value)| (key.to_string(), *value))
                .collect();
            let entries = write_entries(&entries);
            let default_theme = option("defaultTheme");
            let helpers = helpers(&entries, default_theme.as_str());
            let theme = scope(members.get("[\"theme\"]"));

            if walker.unused_selections.contains(&call.start) {
                return format!("{{{helpers}theme:{theme}}}");
            }

            state.uses_selection = true;

            return format!(
                "{{{helpers}theme:{theme},themes:/*#__PURE__*/{selection}.create({entries},{html})}}"
            );
        }

        if members.contains_key("[\"theme\"]") {
            return format!(
                "{{{}theme:{}}}",
                helpers("[]", None),
                scope(members.get("[\"theme\"]"))
            );
        }

        if script || root {
            let helpers = helpers("[]", None);

            return format!("{{{}}}", &helpers[..helpers.len() - 1]);
        }

        "{}".to_owned()
    }

    /// Replaces bound authoring aliases with values that keep their inferred types.
    fn aliases(&self, module: &mut Edits<'a>) -> Result<()> {
        for alias in &self.extracted.theme_aliases {
            let call = &alias.call;
            let kind = match &call.type_text {
                Some(text) => text.to_string(),
                None => format!("import('zyzz').Vars.Definition<{}>", call.token_type),
            };

            if alias.retained {
                if self.typed {
                    let text = self
                        .parsed
                        .source
                        .get(call.start as usize..call.end as usize)
                        .unwrap_or_default();

                    module.overwrite(call.start, call.end, format!("({text} as {kind})"))?;
                }

                continue;
            }

            let member = if call.recipe { "variants" } else { "style" };
            let mut members: Vec<&str> = Vec::new();

            for binding in alias.bindings.iter().flatten() {
                let name = match binding {
                    themes::AliasBinding::Style => "style",
                    themes::AliasBinding::Variants => "variants",
                };

                if !members.contains(&name) {
                    members.push(name);
                }
            }

            if alias.bindings.is_none() {
                members.push(member);
            }

            let value = if alias.destructured {
                format!(
                    "{{{}}}",
                    members
                        .iter()
                        .map(|member| format!("{member}:undefined"))
                        .collect::<Vec<_>>()
                        .join(",")
                )
            } else {
                "undefined".to_owned()
            };
            let assertion = match (self.typed, alias.destructured) {
                (false, _) => String::new(),
                (true, true) => format!(
                    " as unknown as {{{}}}",
                    members
                        .iter()
                        .map(|member| format!("readonly {member}:{kind}['{member}']"))
                        .collect::<Vec<_>>()
                        .join(";")
                ),
                (true, false) => format!(" as unknown as {kind}['{member}']"),
            };

            module.overwrite(call.start, call.end, format!("({value}{assertion})"))?;
        }

        Ok(())
    }

    /// Inlines theme references outside rewritten calls and removes authoring imports that no
    /// remaining code reads.
    fn imports(
        &self,
        module: &mut Edits<'a>,
        walker: &Walker<'_, 'a>,
        program: &Program<'a>,
    ) -> Result<()> {
        let extracted = self.extracted;
        let mut replacements: Vec<(u32, u32)> = extracted
            .calls
            .iter()
            .map(|call| {
                (
                    call.start,
                    walker
                        .applications
                        .get(&call.start)
                        .map_or(call.end, |application| application.end),
                )
            })
            .chain(
                extracted
                    .contribution_calls
                    .iter()
                    .map(|call| (call.start, call.end)),
            )
            .chain(
                extracted
                    .variable_calls
                    .iter()
                    .map(|call| (call.start, call.end)),
            )
            .chain(
                extracted
                    .theme_aliases
                    .iter()
                    .map(|alias| (alias.call.start, alias.call.end)),
            )
            .chain(
                extracted
                    .theme_calls
                    .iter()
                    .map(|call| (call.start, call.end)),
            )
            .collect();

        replacements.sort_by_key(|(start, _)| *start);

        for reference in &extracted.static_theme_references {
            if !replaced(&replacements, reference.start, reference.end) {
                module.overwrite(reference.start, reference.end, quote(&reference.value))?;
            }
        }

        for reference in &extracted.theme_references {
            if !replaced(&replacements, reference.start, reference.end) {
                module.overwrite(
                    reference.start,
                    reference.end,
                    json_class(&self.emitted.vars, &reference.name),
                )?;
            }
        }

        replacements.extend(
            extracted
                .theme_references
                .iter()
                .map(|reference| (reference.start, reference.end)),
        );
        replacements.extend(
            extracted
                .static_theme_references
                .iter()
                .map(|reference| (reference.start, reference.end)),
        );
        replacements.sort_by_key(|(start, _)| *start);

        for statement in &program.body {
            let Statement::ImportDeclaration(node) = statement else {
                continue;
            };
            let names: &[&str] = match node.source.value.as_str() {
                "zyzz/base-ui/react" => &["defineConfig", "style"],
                "zyzz" => &[
                    "Config",
                    "cx",
                    "defineConfig",
                    "defineVars",
                    "extendVars",
                    "style",
                    "Vars",
                    "variable",
                    "variants",
                ],
                "zyzz/web" => &[
                    "Css",
                    "cssFunction",
                    "customMedia",
                    "importCss",
                    "namespace",
                    "colorProfile",
                    "counterStyle",
                    "fontPaletteValues",
                    "fontFeatureValues",
                    "page",
                    "property",
                    "viewTransition",
                    "global",
                    "fontFace",
                    "keyframes",
                    "layers",
                    "positionTry",
                ],
                _ => continue,
            };
            let Some(specifiers) = &node.specifiers else {
                continue;
            };
            let removed: Vec<bool> = specifiers
                .iter()
                .map(|specifier| {
                    let ImportDeclarationSpecifier::ImportSpecifier(specifier) = specifier else {
                        return false;
                    };

                    if node.import_kind == ImportOrExportKind::Type
                        || specifier.import_kind == ImportOrExportKind::Type
                        || !names.contains(&specifier.imported.name().as_str())
                    {
                        return false;
                    }

                    // Conservative retention also protects type queries and shadowed references.
                    !walker
                        .identifiers
                        .get(specifier.local.name.as_str())
                        .is_some_and(|references| {
                            references.iter().any(|reference| {
                                (reference.start < node.span.start || reference.end > node.span.end)
                                    && !replaced(&replacements, reference.start, reference.end)
                            })
                        })
                })
                .collect();

            if !removed.contains(&true) {
                continue;
            }

            let retained: Vec<&ImportDeclarationSpecifier> = specifiers
                .iter()
                .zip(&removed)
                .filter(|(_, removed)| !**removed)
                .map(|(specifier, _)| specifier)
                .collect();

            if retained.is_empty() {
                module.remove(node.span.start, node.span.end)?;
            } else if retained.iter().all(|specifier| {
                !matches!(specifier, ImportDeclarationSpecifier::ImportSpecifier(_))
            }) {
                let text: Vec<&str> = retained
                    .iter()
                    .map(|specifier| specifier.span().source_text(self.parsed.source))
                    .collect();

                module.overwrite(
                    node.span.start,
                    node.source.span.start,
                    format!("import {} from ", text.join(", ")),
                )?;
            } else {
                // Preserve the import source, attributes, and untouched specifier spelling.
                for (index, specifier) in specifiers.iter().enumerate() {
                    if !removed.get(index).copied().unwrap_or_default() {
                        continue;
                    }

                    if let Some(next) = specifiers.get(index + 1) {
                        module.remove(specifier.span().start, next.span().start)?;
                    } else if let Some(previous) =
                        index.checked_sub(1).and_then(|index| specifiers.get(index))
                    {
                        module.remove(previous.span().end, specifier.span().end)?;
                    }
                }
            }
        }

        Ok(())
    }

    /// Imports the runtime helpers the rewritten module reads.
    fn runtime_import(
        &self,
        module: &mut Edits<'a>,
        program: &Program<'a>,
        state: &State,
    ) -> Result<()> {
        let variables = !self.extracted.variable_calls.is_empty();

        if !(state.callable
            || state.uses_recipe
            || state.uses_composition
            || state.uses_composition_html
            || state.uses_conditional_recipe
            || state.uses_payload_recipe
            || state.uses_html
            || state.uses_selection
            || state.uses_appearance
            || variables
            || !state.compositions.is_empty())
        {
            return Ok(());
        }

        let source = self.parsed.source;
        // Insertion after a hashbang keeps executable module syntax intact.
        let hashbang = if source.starts_with("#!") {
            source.find('\n').map_or(0, |index| index + 1)
        } else {
            0
        };
        let offset = program.directives.last().map_or_else(
            || u32::try_from(hashbang).unwrap_or(u32::MAX),
            |directive| directive.span.end,
        );

        if !state.compositions.is_empty() {
            module.append_left(offset, format!("\n{}\n", state.compositions.join("\n")))?;
        }

        let names: Vec<String> = [
            (state.uses_appearance, "Appearance", &state.appearance),
            (state.uses_composition, "Composition", &state.composition),
            (
                state.uses_composition_html,
                "CompositionHtml",
                &state.composition_html,
            ),
            (
                state.uses_conditional_recipe,
                "ConditionalRecipe",
                &state.conditional_recipe,
            ),
            (state.uses_html, "Html", &state.html),
            (
                state.uses_payload_recipe,
                "PayloadRecipe",
                &state.payload_recipe,
            ),
            (state.callable, "Props", &state.runtime),
            (state.uses_recipe, "Recipe", &state.recipe),
            (state.uses_selection, "Selection", &state.selection),
            (variables, "Variable", &state.variables),
        ]
        .into_iter()
        .filter(|(used, _, _)| *used)
        .map(|(_, export, local)| format!("{export} as {local}"))
        .collect();

        // Constant compositions import nothing.
        if !names.is_empty() {
            module.append_left(
                offset,
                format!("\nimport {{ {} }} from 'zyzz/runtime';\n", names.join(", ")),
            )?;
        }

        Ok(())
    }

    /// Renders the module stylesheet with module-scoped selectors and maps each rule, selector,
    /// condition, and declaration to its authored location.
    fn css(
        &self,
        definitions: &FxHashMap<u32, &'a ObjectExpression<'a>>,
        lines: &Lines<'_>,
        module_id: &str,
        vars: Option<&[(Arc<str>, Scope)]>,
    ) -> Result<(String, EncodedSourceMap)> {
        let extracted = self.extracted;
        let emitted = self.emitted;
        let source = self.parsed.source;
        let mut map = GenMapping::new(Some(&format!("{module_id}.css")));

        map.set_source_content(module_id, Some(source));

        // A rule's owner is the first call whose class list holds its class. When calls and
        // compiled styles align, that is the call of the style that created the rule.
        let aligned = extracted.calls.len() == extracted.styles.styles.len()
            && extracted
                .calls
                .iter()
                .zip(&extracted.styles.styles)
                .all(|(call, style)| call.name == style.name);
        let mut owners: FxHashMap<&str, &Call<'a>> = FxHashMap::default();

        if !aligned {
            // Lists that needed no identities moved into the generator.
            let lists = if emitted.classes.is_empty() {
                &self.classes
            } else {
                &emitted.classes
            };

            owners.reserve(emitted.rules.len());

            for call in &extracted.calls {
                for name in split_spaces(
                    lists
                        .get(&call.name)
                        .map(String::as_str)
                        .unwrap_or_default(),
                ) {
                    if !owners.contains_key(name) {
                        owners.insert(name, call);
                    }
                }
            }
        }

        // Aligned owners index their styles directly.
        let styles: FxHashMap<&str, &NamedStyle> = if aligned {
            FxHashMap::default()
        } else {
            extracted
                .styles
                .styles
                .iter()
                .map(|style| (&*style.name, &**style))
                .collect()
        };
        let owner = |name: &str| -> Option<(&Call<'a>, Option<&NamedStyle>)> {
            if aligned {
                let index = *emitted.creators.get(name)?;

                Some((
                    extracted.calls.get(index)?,
                    extracted.styles.styles.get(index).map(|style| &**style),
                ))
            } else {
                let call = owners.get(name).copied()?;

                Some((call, styles.get(&*call.name).copied()))
            }
        };
        let mut theme_owners: FxHashMap<&str, (u32, &str)> = FxHashMap::default();

        for call in &extracted.theme_calls {
            let mut names: Vec<&Arc<str>> = vec![&call.name];

            for name in call.members.iter().flat_map(js::Record::values) {
                if !names.contains(&name) {
                    names.push(name);
                }
            }

            for name in names {
                if let Some(class) = emitted.vars.get(name) {
                    theme_owners.insert(class, (call.start, name));
                }
            }
        }

        let mut linked_owners: FxHashMap<&str, &themes::Owner> = FxHashMap::default();

        for (key, owner) in self.owners.iter().flat_map(|owners| owners.iter()) {
            if let Some(class) = emitted.vars.get(key) {
                linked_owners.insert(class, owner);
            }
        }

        // Literal and scalar-theme rules each occupy one line at this boundary.
        let prefix = emitted.contribution_css.as_deref().unwrap_or_default();
        let contributions: Vec<(&contributions::Definition, Option<u32>)> = extracted
            .contributions
            .iter()
            .enumerate()
            .map(|(index, definition)| {
                (
                    definition,
                    extracted.contribution_starts.get(index).copied(),
                )
            })
            .collect();
        let mut line = 1;

        if let Some((_, start)) = contributions
            .iter()
            .find(|(definition, _)| matches!(&definition.kind, contributions::Kind::Layers { names } if !names.is_empty()))
        {
            if let Some(start) = start {
                map.add_mapping(&Mapping {
                    generated: Position { column: 0, line },
                    name: None,
                    original: Some(lines.position(*start)),
                    source: Some(module_id),
                });
            }

            line += 1;
        }

        let rank = |kind: &contributions::Kind| match kind {
            contributions::Kind::Import { .. } => 0,
            contributions::Kind::Namespace(_) => 1,
            _ => 2,
        };
        let mut sorted = contributions.clone();

        sorted.sort_by_key(|(definition, _)| rank(&definition.kind));

        for (definition, start) in sorted {
            if matches!(definition.kind, contributions::Kind::Layers { .. }) {
                continue;
            }

            let rendered = css::compile(
                &css::Options {
                    contributions: std::slice::from_ref(definition),
                    vars,
                    ..css::Options::default()
                },
                None,
            )?
            .contribution_css
            .unwrap_or_default();

            if rendered.is_empty() {
                continue;
            }

            for _ in rendered.split('\n') {
                if let Some(start) = start {
                    map.add_mapping(&Mapping {
                        generated: Position { column: 0, line },
                        name: None,
                        original: Some(lines.position(start)),
                        source: Some(module_id),
                    });
                }

                line += 1;
            }
        }

        let scoped = emitted.scoped_css.as_deref().unwrap_or(&emitted.css);
        let prefix_lines = if prefix.is_empty() {
            0
        } else {
            memchr::memchr_iter(b'\n', prefix.as_bytes()).count() + 1
        };
        // Calls can share a start, so owners are keyed by identity.
        let mut authored: FxHashMap<*const Call<'a>, Authored<'_>> = FxHashMap::default();
        let mut mapped_conditions: Vec<usize> = Vec::new();
        let mut condition_starts: Vec<usize> = Vec::new();
        let mut starts: Vec<usize> = Vec::new();
        // Rules whose selector needs no rewrite stay borrowed from the emitted text.
        let mut rules: Vec<Cow<'_, str>> = Vec::new();
        let mut openers: FxHashMap<usize, usize> = FxHashMap::default();
        let generated = |column: u32, line: usize| Position {
            column,
            line: u32::try_from(line).unwrap_or(u32::MAX),
        };
        let unmapped = |map: &mut GenMapping, line: usize| {
            map.add_mapping(&Mapping {
                generated: generated(0, line),
                name: None,
                original: None,
                source: None,
            });
        };

        for (index, rule) in scoped
            .split('\n')
            .enumerate()
            .filter(|_| !scoped.is_empty())
        {
            let line = index + 1 + prefix_lines;
            openers.clear();

            // A plain class rule opens one block, which its selector starts.
            match simple_block(rule) {
                Some(brace) => {
                    condition_starts.clear();
                    condition_starts.push(0);
                    openers.insert(0, brace);
                }
                None => declaration_starts(rule, true, Some(&mut openers), &mut condition_starts),
            }

            let selector_start = condition_starts
                .iter()
                .copied()
                .find(|start| rule.as_bytes().get(*start) == Some(&b'.'))
                .unwrap_or(0);
            let Some(brace) = openers
                .get(&selector_start)
                .copied()
                .or_else(|| rule.find('{'))
            else {
                return Err(message("Emitted CSS rule has no block."));
            };
            let name = unescape(rule.get(selector_start + 1..brace).unwrap_or_default());

            if let Some(owner) = linked_owners.get(&*name) {
                map.set_source_content(&owner.module_id, Some(&owner.source));
                map.add_mapping(&Mapping {
                    generated: generated(0, line),
                    name: Some(&owner.call.name),
                    original: Some(end_of(&owner.source, owner.call.start)),
                    source: Some(&owner.module_id),
                });
                rules.push(Cow::Borrowed(rule));
                continue;
            }

            if let Some((start, owner)) = theme_owners.get(&*name) {
                map.add_mapping(&Mapping {
                    generated: generated(0, line),
                    name: Some(owner),
                    original: Some(lines.position(*start)),
                    source: Some(module_id),
                });
                rules.push(Cow::Borrowed(rule));
                continue;
            }

            // Packed theme declarations have no authored source in this graph, and scheme
            // selection rules accompany the scopes.
            if emitted.vars.values().any(|class| *class == name)
                || scheme::CLASSES.iter().any(|(_, class)| *class == name)
            {
                unmapped(&mut map, line);
                rules.push(Cow::Borrowed(rule));
                continue;
            }

            if rule.starts_with(":root{")
                || rule.starts_with(":where(*){--z-")
                || (rule.starts_with("@media ")
                    && (rule.contains(":root{")
                        || rule.contains(":where(*){--z-")
                        || emitted
                            .vars
                            .values()
                            .any(|class| rule.contains(&format!(".{class}{{")))))
            {
                unmapped(&mut map, line);
                rules.push(Cow::Borrowed(rule));
                continue;
            }

            let Some((call, owner_style)) = owner(&name) else {
                return Err(message("Emitted CSS rule has no owning style."));
            };
            let escaped = class_name::selector(&name);
            let selector_column = utf16_column(rule, selector_start);
            let selector_width = u32::try_from(js::utf16_len(&escaped) + 1).unwrap_or(u32::MAX);

            map.add_mapping(&Mapping {
                generated: generated(selector_column, line),
                name: Some(&call.name),
                original: Some(lines.position(call.start)),
                source: Some(module_id),
            });

            let body = rule.get(brace..).unwrap_or_default();

            // An owner's atomic rules share its authored locations, declaration order, and
            // conditions, so each owner reads them once.
            let key = std::ptr::from_ref(call);

            let entry = match authored.entry(key) {
                std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::hash_map::Entry::Vacant(vacant) => {
                    let Some(style) = owner_style else {
                        return Err(message("Emitted CSS rule has no owning style."));
                    };
                    let Some(definition) =
                        call.body.or_else(|| definitions.get(&call.start).copied())
                    else {
                        return Err(message("Emitted CSS rule has no authored definition."));
                    };
                    let mut entry = Authored::default();

                    locations(
                        definition,
                        call,
                        &mut entry.condition_nodes,
                        &mut entry.locations,
                    );
                    entry.declarations = declarations(style);
                    entry.used = vec![false; entry.declarations.len()];
                    collect_conditions(style, &mut entry.conditions);
                    vacant.insert(entry)
                }
            };

            mapped_conditions.clear();

            for start in &condition_starts {
                let condition = rule
                    .get(*start..openers.get(start).copied().unwrap_or(rule.len()))
                    .unwrap_or_default();
                let Some(index) = entry
                    .conditions
                    .iter()
                    .enumerate()
                    .position(|(index, value)| {
                        **value == *condition && !mapped_conditions.contains(&index)
                    })
                else {
                    continue;
                };
                let Some(node) = entry.condition_nodes.get(index) else {
                    continue;
                };

                mapped_conditions.push(index);

                let column = if *start > brace {
                    utf16_column(rule, *start) + selector_width
                        - (utf16_column(rule, brace) - selector_column)
                } else {
                    utf16_column(rule, *start)
                };

                map.add_mapping(&Mapping {
                    generated: generated(column, line),
                    name: Some(node.source_text(source)),
                    original: Some(lines.position(node.start)),
                    source: Some(module_id),
                });
            }

            declaration_starts(body, false, None, &mut starts);

            let mut cursor = 1;

            for (property_index, declaration) in entry.declarations.iter().enumerate() {
                if entry.used.get(property_index).copied().unwrap_or(true) {
                    continue;
                }

                let property = &*declaration.property;
                let Some(start) = starts.iter().copied().find(|start| {
                    *start >= cursor
                        && body
                            .get(*start..)
                            .is_some_and(|rest| declares(rest, property))
                }) else {
                    continue;
                };
                // Composed packed entries can expand differently from the composite's shorthands.
                let Some(location) = entry.locations.get(property_index) else {
                    continue;
                };

                if let Some(used) = entry.used.get_mut(property_index) {
                    *used = true;
                }

                map.add_mapping(&Mapping {
                    generated: generated(
                        selector_column + selector_width + utf16_column(body, start),
                        line,
                    ),
                    name: Some(&declaration.property),
                    original: Some(lines.position(*location)),
                    source: Some(module_id),
                });
                cursor = start + declaration_length(property);
            }

            let authored_selector = rule.get(selector_start..brace).unwrap_or_default();

            rules.push(if authored_selector.strip_prefix('.') == Some(&*escaped) {
                Cow::Borrowed(rule)
            } else {
                Cow::Owned(format!(
                    "{}.{escaped}{body}",
                    rule.get(..selector_start).unwrap_or_default()
                ))
            });
        }

        let rules = rules.join("\n");
        let css = [prefix, rules.as_str()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n");

        Ok((css, map.into_encoded_map()))
    }
}

/// Whether a range starting at or before `start` ends at or after `end`, over ranges sorted by
/// start.
fn replaced(replacements: &[(u32, u32)], start: u32, end: u32) -> bool {
    let count = replacements.partition_point(|(candidate, _)| *candidate <= start);

    count > 0
        && replacements
            .get(count - 1)
            .is_some_and(|(_, last)| end <= *last)
}

/// JavaScript truthiness of static data.
fn truthy(value: &Data) -> bool {
    match value {
        Data::Bool(value) => *value,
        Data::Null | Data::Undefined => false,
        Data::Number(value) => *value != 0.0 && !value.is_nan(),
        Data::String(value) => !value.is_empty(),
        Data::Array(_)
        | Data::Binding(_)
        | Data::Expression(_)
        | Data::Object(_)
        | Data::Theme(_)
        | Data::Token(_) => true,
    }
}

/// Parses a JSON-encoded member path.
fn member_path(key: &str) -> Option<Vec<String>> {
    serde_json::from_str(key).ok()
}

/// `JSON.stringify` of `[name, class]` entries, with missing classes as `null`.
fn write_entries(entries: &[(String, Option<&String>)]) -> String {
    let mut output = String::from("[");

    for (index, (name, class)) in entries.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }

        output.push('[');
        js::write_string(&mut output, name);
        output.push(',');

        match class {
            Some(class) => js::write_string(&mut output, class),
            None => output.push_str("null"),
        }

        output.push(']');
    }

    output.push(']');
    output
}

/// Collects the authored locations of a definition's declarations in emitted order, and the
/// property keys of its conditions.
fn locations(
    node: &ObjectExpression<'_>,
    call: &Call<'_>,
    conditions: &mut Vec<Span>,
    output: &mut Vec<u32>,
) {
    for property in &node.properties {
        let ObjectPropertyKind::ObjectProperty(property) = property else {
            continue;
        };
        let value = unwrap(&property.value);
        // ESTree spells computed identifier keys as `Identifier` too.
        let key = match &property.key {
            PropertyKey::StaticIdentifier(identifier) => {
                Some(Cow::Borrowed(identifier.name.as_str()))
            }
            PropertyKey::Identifier(identifier) => Some(Cow::Borrowed(identifier.name.as_str())),
            key => key_literal(key),
        };

        if let Expression::ObjectExpression(value) = value {
            if key.as_deref() != Some("selectors") {
                conditions.push(property.key.span());
            }

            locations(value, call, conditions, output);
            continue;
        }

        let key = key.unwrap_or_default();

        if key == "typography"
            && let Some(count) = call
                .typography
                .as_ref()
                .and_then(|typography| typography.get(&property.span.start))
        {
            let queries = call
                .typography_queries
                .as_ref()
                .and_then(|queries| queries.get(&property.span.start))
                .copied()
                .unwrap_or_default();

            conditions.extend(std::iter::repeat_n(property.key.span(), queries as usize));
            output.extend(std::iter::repeat_n(property.span.start, *count as usize));
            continue;
        }

        let count = call
            .shorthands
            .as_ref()
            .and_then(|shorthands| shorthands.get(&*key))
            .map_or(1, |names| names.len());

        for _ in 0..count {
            match value {
                Expression::ArrayExpression(array) => output.extend(
                    array
                        .elements
                        .iter()
                        .filter(|element| !matches!(element, ArrayExpressionElement::Elision(_)))
                        .map(|element| element.span().start),
                ),
                _ => output.push(property.span.start),
            }
        }
    }
}
