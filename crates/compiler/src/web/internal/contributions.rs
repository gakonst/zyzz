//! Pure ordered stylesheet contribution data and layer ordering.

use std::sync::Arc;

use indexmap::{IndexMap, IndexSet};
use rustc_hash::FxBuildHasher;

use crate::js;
use crate::style::NamedStyle;
use crate::web::internal::block::{self, Entry};
use crate::web::internal::namespace;

/// An authored scalar descriptor value.
#[derive(Clone, Debug, PartialEq)]
pub enum Scalar {
    /// A number, printed like `Number.prototype.toString`.
    Number(f64),
    /// CSS text.
    String(Arc<str>),
}

impl Scalar {
    /// Appends the value as a template literal interpolates it.
    pub fn write(&self, output: &mut String) {
        match self {
            Self::Number(number) => js::write_number(output, *number),
            Self::String(text) => output.push_str(text),
        }
    }
}

/// The layer clause of an `@import` rule.
#[derive(Clone, Debug, PartialEq)]
pub enum ImportLayer {
    /// `layer`, the anonymous layer.
    Anonymous,
    /// `layer(name)`.
    Named(Arc<str>),
}

/// One kind of stylesheet contribution.
#[derive(Clone, Debug, PartialEq)]
pub enum Kind {
    /// A document-level descriptor rule with descriptors and nested blocks.
    Block {
        /// Descriptors and nested blocks in authored order.
        entries: Vec<Entry>,
        /// CSS rule header.
        header: Arc<str>,
    },
    /// A `@custom-media` statement.
    CustomMedia {
        /// Extension name.
        name: Arc<str>,
        /// Media query list, or `true` or `false` as text.
        query: Arc<str>,
    },
    /// A named descriptor rule such as `@counter-style`.
    Descriptor {
        /// Authored scalar descriptors in JavaScript property order.
        declarations: Vec<(Arc<str>, Scalar)>,
        /// Compiler-owned rule name.
        name: Arc<str>,
        /// CSS descriptor rule family, such as `counter-style`.
        rule: Arc<str>,
    },
    /// A `@font-face` rule.
    FontFace {
        /// Authored scalar descriptors in JavaScript property order.
        declarations: Vec<(Arc<str>, Scalar)>,
    },
    /// An `@import` statement.
    Import {
        /// Cascade layer clause.
        layer: Option<ImportLayer>,
        /// Media query list.
        media: Option<Arc<str>>,
        /// Supports condition.
        supports: Option<Arc<str>>,
        /// Imported URL.
        url: Arc<str>,
    },
    /// A `@keyframes` rule.
    Keyframes {
        /// Frame selectors and their declarations in authored order.
        frames: Vec<(Arc<str>, Arc<NamedStyle>)>,
        /// Animation name.
        name: Arc<str>,
    },
    /// Layer ordering constraints.
    Layers {
        /// Layer names in declared order.
        names: Vec<Arc<str>>,
    },
    /// An `@namespace` statement.
    Namespace(namespace::Definition),
    /// An `@property` registration.
    Property {
        /// Whether the registered value inherits from its parent element.
        inherits: bool,
        /// Computationally independent initial CSS value.
        initial_value: Option<Scalar>,
        /// Registered custom-property name, including the `--` prefix.
        name: Arc<str>,
        /// CSS Properties and Values syntax descriptor.
        syntax: Arc<str>,
    },
    /// A style rule for a selector.
    Rule {
        /// Rule selector.
        selector: Arc<str>,
        /// Declarations and nested rules.
        style: Arc<NamedStyle>,
    },
}

/// Explicit stylesheet data supplied by source adapters or in-memory callers.
#[derive(Clone, Debug, PartialEq)]
pub struct Definition {
    /// The contribution.
    pub kind: Kind,
    /// Enclosing groups in authored outermost-first order.
    pub within: Vec<Arc<str>>,
}

const RESERVED: [&str; 6] = [
    "default",
    "inherit",
    "initial",
    "revert",
    "revert-layer",
    "unset",
];

/// Matches one layer name segment: `(?:--|-?[_a-zA-Z])[\w-]*`.
fn segment(value: &str) -> bool {
    let bytes = value.as_bytes();
    let start = if value.starts_with("--") {
        2
    } else {
        let offset = usize::from(bytes.first() == Some(&b'-'));

        match bytes.get(offset) {
            Some(byte) if *byte == b'_' || byte.is_ascii_alphabetic() => offset + 1,
            _ => return false,
        }
    };

    bytes
        .get(start..)
        .unwrap_or_default()
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'-')
}

type Graph = IndexMap<Box<str>, IndexSet<Box<str>, FxBuildHasher>, FxBuildHasher>;

/// Merges declared layer ordering constraints with deterministic unconstrained ties.
///
/// # Errors
///
/// Returns the TypeScript message for duplicate, invalid, or conflicting layer names.
pub fn order(lists: &[&[Arc<str>]]) -> Result<Vec<Box<str>>, String> {
    let mut scopes: IndexMap<Box<str>, Graph, FxBuildHasher> = IndexMap::default();
    let mut authored: IndexSet<Box<str>, FxBuildHasher> = IndexSet::default();

    for list in lists {
        let unique: IndexSet<&str, FxBuildHasher> = list.iter().map(|name| &**name).collect();

        if unique.len() != list.len() {
            return Err("Duplicate layer name.".to_owned());
        }

        for name in *list {
            if !name.split('.').all(segment)
                || name
                    .split('.')
                    .any(|part| RESERVED.contains(&part.to_ascii_lowercase().as_str()))
            {
                return Err("Invalid layer name.".to_owned());
            }

            authored.insert((**name).into());

            let parts: Vec<&str> = name.split('.').collect();

            for (index, part) in parts.iter().enumerate() {
                let parent = parts.get(..index).unwrap_or_default().join(".");
                let graph = scopes.entry(parent.into()).or_default();

                graph.entry((*part).into()).or_default();
            }
        }

        for pair in list.windows(2) {
            let [before, after] = pair else {
                continue;
            };
            let before: Vec<&str> = before.split('.').collect();
            let after: Vec<&str> = after.split('.').collect();
            let at = before
                .iter()
                .enumerate()
                .position(|(index, value)| after.get(index) != Some(value));

            if let Some(at) = at
                && let (Some(target), Some(source)) = (after.get(at), before.get(at))
            {
                let parent = before.get(..at).unwrap_or_default().join(".");

                if let Some(edges) = scopes
                    .get_mut(parent.as_str())
                    .and_then(|graph| graph.get_mut(*source))
                {
                    edges.insert((*target).into());
                }
            }
        }
    }

    let mut result = Vec::new();

    emit("", &mut scopes, &authored, &mut result)?;

    Ok(result)
}

fn emit(
    parent: &str,
    scopes: &mut IndexMap<Box<str>, Graph, FxBuildHasher>,
    authored: &IndexSet<Box<str>, FxBuildHasher>,
    result: &mut Vec<Box<str>>,
) -> Result<(), String> {
    loop {
        let Some(graph) = scopes.get_mut(parent) else {
            return Ok(());
        };

        if graph.is_empty() {
            return Ok(());
        }

        let next = graph
            .keys()
            .find(|name| !graph.values().any(|targets| targets.contains(*name)))
            .cloned()
            .ok_or_else(|| "Conflicting layer order constraints.".to_owned())?;
        let name: Box<str> = if parent.is_empty() {
            next.clone()
        } else {
            format!("{parent}.{next}").into()
        };

        if authored.contains(&name) {
            result.push(name.clone());
        }

        graph.shift_remove(&next);
        emit(&name, scopes, authored, result)?;
    }
}

fn rank(value: &Definition) -> u8 {
    match value.kind {
        Kind::Import { .. } => 0,
        Kind::Namespace(_) => 1,
        _ => 2,
    }
}

/// Renders static contributions without registration or environment access.
///
/// # Errors
///
/// Returns the TypeScript message when layer ordering constraints are invalid.
pub fn render<'s>(
    definitions: &'s [Definition],
    style: &mut dyn FnMut(&mut String, &'s NamedStyle),
) -> Result<String, String> {
    let lists: Vec<&[Arc<str>]> = definitions
        .iter()
        .filter_map(|value| match &value.kind {
            Kind::Layers { names } => Some(names.as_slice()),
            _ => None,
        })
        .collect();
    let layers = order(&lists)?;
    let mut sorted: Vec<&Definition> = definitions.iter().collect();
    let mut output = String::new();

    sorted.sort_by_key(|value| rank(value));

    if !layers.is_empty() {
        output.push_str("@layer ");

        for (index, layer) in layers.iter().enumerate() {
            if index > 0 {
                output.push(',');
            }

            output.push_str(layer);
        }

        output.push(';');
    }

    for value in sorted {
        if matches!(value.kind, Kind::Layers { .. }) {
            continue;
        }

        if !output.is_empty() {
            output.push('\n');
        }

        for header in &value.within {
            output.push_str(header);
            output.push('{');
        }

        write(&mut output, &value.kind, style);

        for _ in &value.within {
            output.push('}');
        }
    }

    Ok(output)
}

fn write<'s>(
    output: &mut String,
    kind: &'s Kind,
    style: &mut dyn FnMut(&mut String, &'s NamedStyle),
) {
    match kind {
        Kind::Namespace(definition) => output.push_str(&namespace::statement(definition)),
        Kind::CustomMedia { name, query } => {
            output.push_str("@custom-media ");
            output.push_str(name);
            output.push(' ');
            output.push_str(query);
            output.push(';');
        }
        Kind::Import {
            layer,
            media,
            supports,
            url,
        } => {
            output.push_str("@import url(");
            js::write_string(output, url);
            output.push(')');

            match layer {
                Some(ImportLayer::Anonymous) => output.push_str(" layer"),
                Some(ImportLayer::Named(name)) => {
                    output.push_str(" layer(");
                    output.push_str(name);
                    output.push(')');
                }
                None => {}
            }

            if let Some(supports) = supports {
                output.push_str(" supports(");
                output.push_str(supports);
                output.push(')');
            }

            if let Some(media) = media {
                output.push(' ');
                output.push_str(media);
            }

            output.push(';');
        }
        Kind::Block { entries, header } => {
            output.push_str(header);
            output.push('{');
            block::render(output, entries, style);
            output.push('}');
        }
        Kind::Rule {
            selector,
            style: body,
        } => {
            output.push_str(selector);
            output.push('{');
            style(output, body);
            output.push('}');
        }
        Kind::Property {
            inherits,
            initial_value,
            name,
            syntax,
        } => {
            output.push_str("@property ");
            output.push_str(name);
            output.push_str("{syntax:");
            js::write_string(output, syntax);
            output.push_str(";inherits:");
            output.push_str(if *inherits { "true" } else { "false" });
            output.push(';');

            if let Some(value) = initial_value {
                output.push_str("initial-value:");
                value.write(output);
                output.push(';');
            }

            output.push('}');
        }
        Kind::FontFace { declarations } => {
            output.push_str("@font-face{");
            descriptors(output, declarations);
            output.push('}');
        }
        Kind::Descriptor {
            declarations,
            name,
            rule,
        } => {
            output.push('@');
            output.push_str(rule);
            output.push(' ');
            output.push_str(name);
            output.push('{');
            descriptors(output, declarations);
            output.push('}');
        }
        Kind::Keyframes { frames, name } => {
            output.push_str("@keyframes ");
            output.push_str(name);
            output.push('{');

            for (stop, body) in frames {
                output.push_str(stop);
                output.push('{');
                style(output, body);
                output.push('}');
            }

            output.push('}');
        }
        Kind::Layers { .. } => {}
    }
}

/// Writes descriptors with camelCase names converted to kebab-case.
fn descriptors(output: &mut String, declarations: &[(Arc<str>, Scalar)]) {
    for (key, value) in declarations {
        for character in key.chars() {
            if character.is_ascii_uppercase() {
                output.push('-');
                output.push(character.to_ascii_lowercase());
            } else {
                output.push(character);
            }
        }

        output.push(':');
        value.write(output);
        output.push(';');
    }
}
