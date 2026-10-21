//! Legacy theme definitions: token palettes, color schemes, typography sets, and query thresholds.

use std::sync::Arc;

use indexmap::IndexMap;

use crate::data::{Data, Object, Property};
use crate::error::{Error, Result};
use crate::internal::identity;
use crate::internal::query::{self, Metadata as Queries};
use crate::internal::token::{self, Contract, Map, Metadata, Value};
use crate::internal::{condition, typography};
use crate::js;

/// How a definition derives its scope class name.
#[derive(Clone, Debug, PartialEq)]
pub enum ClassName {
    /// From the contract identity, failing for definitions that need the compiler.
    Contract,
    /// Fixed when the definition was rebound: rebinding keeps the original class name, or its
    /// failure, as the `className` getter closes over the original definition.
    Fixed(std::result::Result<Arc<str>, Error>),
    /// From a compiler-assigned scope.
    Scope(Arc<str>),
    /// From a variable set's contract identity, falling back to the contract rule.
    VariableSet,
}

/// A theme or variable set definition.
#[derive(Clone, Debug, PartialEq)]
pub struct Definition {
    /// How the scope class name is derived.
    pub class_name: ClassName,
    /// Contract, values, and queries.
    pub metadata: Metadata,
    /// Token references as a nested object tree.
    pub tokens: Data,
    /// Web variable references with the same shape as `tokens`.
    pub vars: Data,
}

impl Definition {
    /// The compiled scope class, as the `className` getter returns it.
    ///
    /// # Errors
    ///
    /// Returns [`Error::MissingTransform`] when the class depends on a compiler scope.
    pub fn class_name(&self) -> Result<String> {
        let contract_class = || {
            let id = self
                .metadata
                .contract
                .identity
                .as_deref()
                .filter(|id| id.starts_with("id-"));

            id.map(|id| format!("z-theme-{}", id.get(3..).unwrap_or_default()))
                .ok_or(Error::MissingTransform)
        };

        match &self.class_name {
            ClassName::Fixed(class_name) => class_name
                .as_ref()
                .map(ToString::to_string)
                .map_err(Clone::clone),
            ClassName::Scope(scope) => Ok(format!("z-theme-{scope}")),
            ClassName::Contract => contract_class(),
            ClassName::VariableSet => match self.metadata.contract.identity.as_deref() {
                Some(identity) => Ok(format!(
                    "z-theme-{}",
                    identity
                        .strip_prefix("id-")
                        .map_or_else(|| identity::name(identity), str::to_owned)
                )),
                None => contract_class(),
            },
        }
    }
}

const COLOR_GROUPS: [&str; 4] = ["color", "backgroundColor", "borderColor", "textColor"];

const TOKEN_GROUPS: [&str; 15] = [
    "backgroundColor",
    "borderColor",
    "borderRadius",
    "borderWidth",
    "color",
    "margin",
    "padding",
    "spacing",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "letterSpacing",
    "lineHeight",
    "textColor",
    "typography",
];

const CONTAINER_RESERVED: [&str; 10] = [
    "none",
    "and",
    "not",
    "or",
    "default",
    "inherit",
    "initial",
    "unset",
    "revert",
    "revert-layer",
];

/// Defines a theme. An `id` makes the theme usable without the compiler.
///
/// # Errors
///
/// Returns [`Error::Theme`] for invalid palettes, and [`Error::Message`] for an empty id.
pub fn define(tokens: &Data, id: Option<&str>) -> Result<Definition> {
    let identity = id
        .map(|id| identity::require_id(Some(id), "Theme.define"))
        .transpose()?;
    let contract = Arc::new(match &identity {
        Some(identity) => Contract {
            complete: true,
            identity: Some(identity.as_str().into()),
            ..Contract::default()
        },
        None => Contract::default(),
    });

    build(
        tokens,
        contract,
        None,
        None,
        identity.as_deref().map(Into::into),
        None,
    )
}

/// Overrides existing token values of a theme without adding paths.
///
/// # Errors
///
/// Returns [`Error::Theme`] when overrides add paths, change shapes, or are invalid.
pub fn extend(theme: &Definition, overrides: &Data) -> Result<Definition> {
    let data = &theme.metadata;

    build(
        overrides,
        Arc::clone(&data.contract),
        Some(&data.values),
        data.queries.as_deref(),
        None,
        data.paths.as_ref(),
    )
}

fn invalid(path: &[Arc<str>], message: &str) -> Error {
    Error::Theme {
        message: message.to_owned(),
        path: path.iter().map(std::string::ToString::to_string).collect(),
    }
}

/// Builds a definition from authored tokens, optionally over a base theme.
pub(crate) fn build(
    input: &Data,
    contract: Arc<Contract>,
    base: Option<&Map<Value>>,
    base_queries: Option<&Queries>,
    scope: Option<Arc<str>>,
    base_paths: Option<&Map<Arc<[Arc<str>]>>>,
) -> Result<Definition> {
    let mut values: Map<Value> = base.cloned().unwrap_or_default();
    let mut queries = Queries {
        breakpoint: base_queries
            .map(|queries| queries.breakpoint.clone())
            .unwrap_or_default(),
        container: base_queries
            .map(|queries| queries.container.clone())
            .unwrap_or_default(),
        container_names: base_queries
            .map(|queries| queries.container_names.clone())
            .unwrap_or_default(),
    };
    let mut paths: Map<Arc<[Arc<str>]>> = base_paths.cloned().unwrap_or_default();
    let mut conditions: Vec<Vec<Arc<str>>> = Vec::new();
    let mut has_queries = base_queries.is_some();
    let mut builder = Builder {
        base,
        conditions: &mut conditions,
        paths: &mut paths,
        values: &mut values,
        active: Vec::new(),
    };

    for (group, palette) in record(input, &[])? {
        if palette.is_undefined() {
            continue;
        }

        let group_path = [Arc::clone(&group)];

        if &*group == "containerNames" {
            has_queries = true;

            let names = container_names(&palette)
                .ok_or_else(|| invalid(&group_path, "Expected unique container identifiers."))?;

            if base.is_some()
                && Some(&names) != base_queries.map(|queries| &queries.container_names)
            {
                return Err(invalid(
                    &group_path,
                    "Extensions cannot change container identities.",
                ));
            }

            queries.container_names = names;
            continue;
        }

        if &*group == "breakpoint" || &*group == "container" {
            has_queries = true;

            for (name, value) in record(&palette, &group_path)? {
                let valid = !name.is_empty()
                    && name.bytes().enumerate().all(|(index, byte)| {
                        byte.is_ascii_alphanumeric() || byte == b'_' || (index > 0 && byte == b'-')
                    })
                    && !(&*group == "breakpoint" && matches!(&*name, "all" | "screen" | "print"))
                    && value.as_str().is_some_and(query::threshold);

                if !valid {
                    return Err(invalid(
                        &[Arc::clone(&group), name],
                        "Expected a named nonnegative length threshold.",
                    ));
                }

                let thresholds = if &*group == "breakpoint" {
                    &mut queries.breakpoint
                } else {
                    &mut queries.container
                };

                if base.is_some() && !thresholds.contains_key(&*name) {
                    return Err(invalid(
                        &[Arc::clone(&group), name],
                        "Extensions cannot add query thresholds.",
                    ));
                }

                thresholds.insert(
                    name.to_string(),
                    value.as_str().unwrap_or_default().to_owned(),
                );
            }

            continue;
        }

        if !TOKEN_GROUPS.contains(&&*group) {
            return Err(invalid(&group_path, "Unsupported token group."));
        }

        if let Some(base) = base
            && !base.keys().any(|key| key.starts_with(&format!("{group}.")))
        {
            return Err(invalid(&group_path, "Extensions cannot add token groups."));
        }

        // Groups are always records; scalar leaves begin below them.
        let entries = record(&palette, &group_path)?;

        if entries.is_empty() && base.is_none() {
            return Err(invalid(&group_path, "Token palettes cannot be empty."));
        }

        for (name, value) in entries {
            if &*group == "typography"
                && (typography::PROPERTIES.contains(&&*name) || name.starts_with('@'))
            {
                return Err(invalid(
                    &[Arc::clone(&group), name],
                    "Typography properties require a named set.",
                ));
            }

            builder.visit(&value, &group, &[Arc::clone(&group), name])?;
        }
    }

    for path in &conditions {
        let key = path.last().map(|key| &**key).unwrap_or_default();

        query::resolve(key, &queries)
            .and_then(|resolved| condition::normalize(&resolved))
            .map_err(|error| invalid(path, &error.text()))?;
    }

    let mut tokens = TreeBuilder::default();

    for (path, value) in &values {
        let parts: Vec<Arc<str>> = paths.get(path).map_or_else(
            || path.split('.').map(Into::into).collect(),
            |parts| parts.to_vec(),
        );
        let group: &str = if parts.first().map(|part| &**part) == Some("typography") {
            parts.last().map(|part| &**part).unwrap_or_default()
        } else {
            parts.first().map(|part| &**part).unwrap_or_default()
        };

        tokens.insert(
            &parts,
            Data::Token(token::create(
                &contract,
                group,
                Arc::clone(path),
                value.clone(),
            )),
        );
    }

    let tokens = tokens.finish();
    let vars = token::variables(&tokens);

    Ok(Definition {
        class_name: scope.map_or(ClassName::Contract, ClassName::Scope),
        metadata: Metadata {
            contract,
            css_name: None,
            paths: (!paths.is_empty()).then_some(paths),
            queries: has_queries.then(|| Arc::new(queries)),
            values: Arc::new(values),
        },
        tokens,
        vars,
    })
}

struct Builder<'a> {
    active: Vec<*const Object>,
    base: Option<&'a Map<Value>>,
    conditions: &'a mut Vec<Vec<Arc<str>>>,
    paths: &'a mut Map<Arc<[Arc<str>]>>,
    values: &'a mut Map<Value>,
}

impl Builder<'_> {
    fn visit(&mut self, value: &Data, group: &str, path: &[Arc<str>]) -> Result<()> {
        let key: Arc<str> = path
            .iter()
            .map(|part| &**part)
            .collect::<Vec<_>>()
            .join(".")
            .into();

        if path.iter().any(|part| part.starts_with('@')) {
            self.paths.insert(Arc::clone(&key), path.into());
        }

        let scalar = value.is_scalar();

        if group == "typography" && scalar {
            return Err(invalid(
                path,
                "Expected a typography set or a nested set group.",
            ));
        }

        let entries = if scalar {
            None
        } else {
            Some(record(value, path)?)
        };
        let pair = COLOR_GROUPS.contains(&group)
            && entries.as_ref().is_some_and(|entries| {
                entries
                    .iter()
                    .any(|(name, _)| &**name == "light" || &**name == "dark")
            });

        if scalar || pair {
            if let Some(base) = self.base
                && !base.contains_key(&*key)
            {
                return Err(invalid(
                    path,
                    "Extensions cannot add or replace token paths.",
                ));
            }

            if pair {
                let entries = entries.unwrap_or_default();
                let light = entries.iter().find(|(name, _)| &**name == "light");
                let dark = entries.iter().find(|(name, _)| &**name == "dark");
                let (Some((_, light)), Some((_, dark)), 2) = (light, dark, entries.len()) else {
                    return Err(invalid(path, "Expected a complete light/dark color pair."));
                };

                self.values.insert(
                    key,
                    Value::Record(Arc::from([
                        ("dark".into(), scalar_value(dark)),
                        ("light".into(), scalar_value(light)),
                    ])),
                );
            } else {
                self.values.insert(key, scalar_value(value));
            }

            return Ok(());
        }

        let entries = entries.unwrap_or_default();

        if entries.is_empty() && self.base.is_none() {
            return Err(invalid(path, "Token palettes cannot be empty."));
        }

        if self.base.is_some_and(|base| base.contains_key(&*key)) {
            return Err(invalid(path, "A token leaf cannot become a palette."));
        }

        let identity = match value {
            Data::Object(object) => Arc::as_ptr(object),
            _ => std::ptr::null(),
        };

        if self.active.contains(&identity) {
            return Err(invalid(path, "Cyclic palettes are not supported."));
        }

        self.active.push(identity);

        for (name, child) in entries {
            let mut next = path.to_vec();
            next.push(Arc::clone(&name));

            if group == "typography" && name.starts_with('@') {
                if !typography::condition(&name) {
                    return Err(invalid(
                        &next,
                        "Typography conditions must be media or container queries.",
                    ));
                }

                self.conditions.push(next.clone());
            }

            if group == "typography"
                && path.iter().any(|part| part.starts_with('@'))
                && !typography::condition(&name)
                && !typography::PROPERTIES.contains(&&*name)
            {
                return Err(invalid(
                    &next,
                    "Typography query blocks accept only typography fields and queries.",
                ));
            }

            if let Some(base) = self.base {
                let joined = next
                    .iter()
                    .map(|part| &**part)
                    .collect::<Vec<_>>()
                    .join(".");
                let prefix = format!("{joined}.");

                if !base
                    .keys()
                    .any(|key| **key == *joined || key.starts_with(&prefix))
                {
                    return Err(invalid(&next, "Extensions cannot add token paths."));
                }
            }

            let property = (group == "typography" && typography::PROPERTIES.contains(&&*name))
                .then_some(&*name);

            if property.is_some() && !child.is_scalar() {
                return Err(invalid(
                    &next,
                    "Typography properties require scalar values.",
                ));
            }

            self.visit(&child, property.unwrap_or(group), &next)?;
        }

        self.active.retain(|candidate| *candidate != identity);

        Ok(())
    }
}

/// Converts a validated scalar or pair member into a token value.
fn scalar_value(value: &Data) -> Value {
    match value {
        Data::Number(number) => Value::Number(*number),
        Data::String(text) => Value::String(Arc::clone(text)),
        Data::Token(reference) => Value::Reference(Arc::clone(reference)),
        Data::Expression(expression) => Value::Composition(Arc::clone(expression)),
        // Pair members keep arbitrary authored data, matching the unchecked TypeScript copy.
        other => Value::String(other.to_js_string().into()),
    }
}

/// Validates the container identifier list.
fn container_names(value: &Data) -> Option<Vec<String>> {
    let Data::Array(items) = value else {
        return None;
    };
    let mut names: Vec<String> = Vec::with_capacity(items.len());

    for item in items.iter() {
        let name = item.as_str()?;

        if !identifier(name)
            || CONTAINER_RESERVED.contains(&name.to_lowercase().as_str())
            || names.iter().any(|other| other == name)
        {
            return None;
        }

        names.push(name.to_owned());
    }

    Some(names)
}

/// Matches a CSS identifier, including escapes and non-ASCII code points.
pub(crate) fn identifier(name: &str) -> bool {
    let mut characters = name.chars().peekable();
    let escape = |characters: &mut std::iter::Peekable<std::str::Chars<'_>>| -> bool {
        let mut hex = 0;

        while hex < 6 && characters.peek().is_some_and(char::is_ascii_hexdigit) {
            characters.next();
            hex += 1;
        }

        if hex > 0 {
            characters.next_if(|character| matches!(character, ' ' | '\t' | '\n' | '\r' | '\u{c}'));
            return true;
        }

        characters
            .next()
            .is_some_and(|character| !matches!(character, '\n' | '\r' | '\u{c}'))
    };

    if name.starts_with("--") {
        characters.next();
        characters.next();
    } else {
        characters.next_if_eq(&'-');

        match characters.next() {
            Some('\\') => {
                if !escape(&mut characters) {
                    return false;
                }
            }
            Some(character)
                if character == '_' || character.is_ascii_alphabetic() || !character.is_ascii() => {
            }
            _ => return false,
        }
    }

    while let Some(character) = characters.next() {
        if character == '\\' {
            if !escape(&mut characters) {
                return false;
            }
        } else if !(character == '-'
            || character == '_'
            || character.is_ascii_alphanumeric()
            || !character.is_ascii())
        {
            return false;
        }
    }

    true
}

/// Lists the data properties of a plain record.
fn record(value: &Data, path: &[Arc<str>]) -> Result<Vec<(Arc<str>, Data)>> {
    let Data::Object(object) = value else {
        return Err(invalid(path, "Expected a plain data record."));
    };

    if object.exotic {
        return Err(invalid(path, "Expected a plain data record."));
    }

    let mut entries = Vec::with_capacity(object.len());

    for (key, property) in object.properties() {
        let mut next = path.to_vec();
        next.push(Arc::clone(key));

        if key.contains('!') {
            return Err(invalid(
                &next,
                "Token keys cannot contain !; it is reserved for declaration importance.",
            ));
        }

        let dotted = key.contains('.')
            && !(path.first().map(|part| &**part) == Some("typography")
                && typography::condition(key));

        match property {
            Property::Value(value) if !key.is_empty() && !dotted => {
                entries.push((Arc::clone(key), value.clone()));
            }
            _ => {
                return Err(invalid(
                    path,
                    "Expected nonempty keys without dots and enumerable data properties.",
                ));
            }
        }
    }

    Ok(entries)
}

/// Builds nested plain objects from path segments, keeping insertion order.
#[derive(Default)]
pub(crate) struct TreeBuilder {
    entries: IndexMap<Arc<str>, Node, rustc_hash::FxBuildHasher>,
}

enum Node {
    Leaf(Data),
    Tree(TreeBuilder),
}

impl TreeBuilder {
    /// Sets the value at a path, creating intermediate objects.
    pub(crate) fn insert(&mut self, parts: &[Arc<str>], value: Data) {
        let Some((last, parents)) = parts.split_last() else {
            return;
        };
        let mut tree = self;

        for part in parents {
            let node = tree
                .entries
                .entry(Arc::clone(part))
                .or_insert_with(|| Node::Tree(Self::default()));

            if let Node::Leaf(_) = node {
                *node = Node::Tree(Self::default());
            }

            let Node::Tree(next) = node else {
                return;
            };

            tree = next;
        }

        tree.entries.insert(Arc::clone(last), Node::Leaf(value));
    }

    /// Freezes the tree into nested plain objects.
    pub(crate) fn finish(self) -> Data {
        Data::from(Object::from_entries(self.entries.into_iter().map(
            |(key, node)| {
                let value = match node {
                    Node::Leaf(value) => value,
                    Node::Tree(tree) => tree.finish(),
                };

                (key, value)
            },
        )))
    }
}

/// Formats a path like `JSON.stringify(path)`.
pub(crate) fn path_json(path: &[String]) -> String {
    js::stringify(&js::Value::Array(
        path.iter()
            .map(|part| js::Value::String(part.clone()))
            .collect(),
    ))
}
