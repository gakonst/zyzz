//! Theme contracts, token references, and token resolution for declaration values.
//!
//! Contracts and references are immutable and shared through [`Arc`]. Contract identity follows
//! pointer identity, as frozen contract objects do in TypeScript.

use std::sync::Arc;

use compact_str::CompactString;
use indexmap::IndexMap;
use rustc_hash::FxBuildHasher;

use crate::data::{Data, Object};
use crate::generated::{literal as rules, token as groups};
use crate::internal::binding::{self, Domain};
use crate::internal::literal::{self, Scalar};
use crate::internal::query;
use crate::internal::theme;

/// An ordered string-keyed map.
pub type Map<V> = IndexMap<Arc<str>, V, FxBuildHasher>;

/// Category property mappings for a variable set, or `false` to disable inferred categories.
#[derive(Clone, Debug, PartialEq)]
pub enum Mappings {
    /// Inferred categories are disabled. Paths resolve only by their full name.
    Disabled,
    /// Properties accepted by each category, sorted by category name.
    Categories(Map<Arc<[Arc<str>]>>),
}

/// Composition mode for compiled applications.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Composition {
    /// Complete applications deduplicate and share equal atomic declarations.
    Independent,
    /// Conflicting rules retain authored order.
    Ordered,
}

impl Composition {
    /// Parses the TypeScript spelling.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "independent" => Some(Self::Independent),
            "ordered" => Some(Self::Ordered),
            _ => None,
        }
    }

    /// The TypeScript spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Independent => "independent",
            Self::Ordered => "ordered",
        }
    }
}

/// Web CSS representation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CssOutput {
    /// One rule per declaration domain.
    Atomic,
    /// One rule per style.
    Grouped,
}

impl CssOutput {
    /// Parses the TypeScript spelling.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "atomic" => Some(Self::Atomic),
            "grouped" => Some(Self::Grouped),
            _ => None,
        }
    }

    /// The TypeScript spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Atomic => "atomic",
            Self::Grouped => "grouped",
        }
    }
}

/// The owner of a set of tokens. References compare contracts by identity.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Contract {
    /// Whether every token of this contract is known, so packed consumers need no extension.
    pub complete: bool,
    /// Composition inherited by styles defined from this contract.
    pub composition: Option<Composition>,
    /// CSS output inherited by styles defined from this contract.
    pub css_output: Option<CssOutput>,
    /// Layer applied to styles without an explicit layer.
    pub default_layer: Option<Arc<str>>,
    /// Stable identity for generated names, such as `id-brand` or a compiler scope.
    pub identity: Option<Arc<str>>,
    /// Creation order of the enumerable properties, which `JSON.stringify` follows. `None`
    /// lists present properties in [`ContractKey::ORDER`].
    pub keys: Option<Arc<[ContractKey]>>,
    /// Category mappings for variable sets.
    pub mappings: Option<Mappings>,
    /// Shorthand names that expand to several properties.
    pub shorthands: Option<Map<Arc<[Arc<str>]>>>,
    /// Whether the contract belongs to a variable set rather than a legacy theme.
    pub variable_set: bool,
}

/// An enumerable string-keyed contract property. Symbol-keyed identity and completeness never
/// reach `JSON.stringify`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContractKey {
    /// `composition`
    Composition,
    /// `cssOutput`
    CssOutput,
    /// `defaultLayer`
    DefaultLayer,
    /// `mappings`
    Mappings,
    /// `shorthands`
    Shorthands,
    /// `variableSet`
    VariableSet,
}

impl ContractKey {
    /// The property order of a configuration contract, used when a contract records none.
    pub const ORDER: [Self; 6] = [
        Self::VariableSet,
        Self::Mappings,
        Self::Composition,
        Self::DefaultLayer,
        Self::CssOutput,
        Self::Shorthands,
    ];

    /// Parses the TypeScript property name.
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "composition" => Self::Composition,
            "cssOutput" => Self::CssOutput,
            "defaultLayer" => Self::DefaultLayer,
            "mappings" => Self::Mappings,
            "shorthands" => Self::Shorthands,
            "variableSet" => Self::VariableSet,
            _ => return None,
        })
    }

    /// The TypeScript property name.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Composition => "composition",
            Self::CssOutput => "cssOutput",
            Self::DefaultLayer => "defaultLayer",
            Self::Mappings => "mappings",
            Self::Shorthands => "shorthands",
            Self::VariableSet => "variableSet",
        }
    }
}

/// A token category name, such as `color`, `spacing`, or a variable-set domain.
pub type Group = CompactString;

/// A theme token value.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    /// A composition of CSS text and references.
    Composition(Arc<Expression>),
    /// A number.
    Number(f64),
    /// A light/dark pair or media conditions with a `default`, in authored key order.
    Record(Arc<[(Arc<str>, Value)]>),
    /// A reference to another token.
    Reference(Arc<Reference>),
    /// A string.
    String(Arc<str>),
}

impl Value {
    /// Reads a record entry.
    pub fn field(&self, key: &str) -> Option<&Value> {
        match self {
            Self::Record(entries) => entries
                .iter()
                .find(|(name, _)| &**name == key)
                .map(|(_, value)| value),
            _ => None,
        }
    }
}

/// A reference to one token of a contract.
#[derive(Clone, Debug)]
pub struct Reference {
    /// Owning contract.
    pub contract: Arc<Contract>,
    /// Token category.
    pub group: Group,
    /// Dotted path from the token root.
    pub path: Arc<str>,
    /// Resolved token value.
    pub value: Value,
    /// Whether the reference was read from a `vars` tree, which retains web variable identity.
    pub web: bool,
}

impl PartialEq for Reference {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.contract, &other.contract)
            && self.group == other.group
            && self.path == other.path
            && self.value == other.value
            && self.web == other.web
    }
}

/// One part of an expression.
#[derive(Clone, Debug, PartialEq)]
pub enum Part {
    /// A binding slot.
    Binding(Arc<binding::Reference>),
    /// A token reference.
    Reference(Arc<Reference>),
    /// CSS text.
    Text(Arc<str>),
}

/// A CSS value interpolating references. Compositions also carry a color or spacing group.
#[derive(Clone, Debug, PartialEq)]
pub struct Expression {
    /// Domain of a composition. `None` for a declaration expression.
    pub group: Option<Group>,
    /// Text and references in authored order.
    pub parts: Vec<Part>,
}

/// Contract, values, and query metadata for one theme or variable set. Metadata compares its
/// contract by identity, as references do.
#[derive(Clone, Debug)]
pub struct Metadata {
    /// Contract that owns every token.
    pub contract: Arc<Contract>,
    /// Readable CSS name used for generated variables.
    pub css_name: Option<Arc<str>>,
    /// Explicit path segments for paths whose keys contain dots.
    pub paths: Option<Map<Arc<[Arc<str>]>>>,
    /// Breakpoint and container thresholds.
    pub queries: Option<Arc<query::Metadata>>,
    /// Token values keyed by dotted path.
    pub values: Arc<Map<Value>>,
}

impl PartialEq for Metadata {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.contract, &other.contract)
            && self.css_name == other.css_name
            && self.paths == other.paths
            && self.queries == other.queries
            && self.values == other.values
    }
}

/// Creates a token reference.
pub fn create(
    contract: &Arc<Contract>,
    group: impl Into<Group>,
    path: impl Into<Arc<str>>,
    value: Value,
) -> Arc<Reference> {
    Arc::new(Reference {
        contract: Arc::clone(contract),
        group: group.into(),
        path: path.into(),
        value,
        web: false,
    })
}

/// Creates a declaration expression.
pub fn compose(parts: Vec<Part>) -> Arc<Expression> {
    Arc::new(Expression { group: None, parts })
}

const SPACING: [&str; 23] = [
    "blockSize",
    "bottom",
    "columnGap",
    "flexBasis",
    "gap",
    "height",
    "inlineSize",
    "left",
    "maxBlockSize",
    "maxHeight",
    "maxInlineSize",
    "maxWidth",
    "minBlockSize",
    "minHeight",
    "minInlineSize",
    "minWidth",
    "right",
    "rowGap",
    "textDecorationThickness",
    "textIndent",
    "textUnderlineOffset",
    "top",
    "width",
];

/// Whether a legacy token group applies to a property.
pub fn accepts(group: &str, property: &str) -> bool {
    if property.starts_with("--") {
        return true;
    }

    match group {
        "number" | "string" => false,
        "color" => literal::rule(property).is_some_and(|rule| rule.kind == rules::Kind::Color),
        "borderColor" => property.starts_with("border") && property.ends_with("Color"),
        "borderWidth" => border_width(property),
        "borderRadius" => property.starts_with("border") && property.ends_with("Radius"),
        "textColor" => property == "color",
        "margin" => property.starts_with("margin") && property != "marginTrim",
        "padding" => property.starts_with("padding"),
        "spacing" => {
            property != "marginTrim"
                && (["padding", "margin", "inset", "scrollPadding"]
                    .iter()
                    .any(|prefix| property.starts_with(prefix))
                    || SPACING.contains(&property))
        }
        _ => group == property,
    }
}

/// Matches `^border(?:Block|Inline)?(?:Start|End|Top|Right|Bottom|Left)?Width$`.
fn border_width(property: &str) -> bool {
    let Some(rest) = property
        .strip_prefix("border")
        .and_then(|rest| rest.strip_suffix("Width"))
    else {
        return false;
    };
    let rest = rest
        .strip_prefix("Block")
        .or_else(|| rest.strip_prefix("Inline"))
        .unwrap_or(rest);

    matches!(
        rest,
        "" | "Start" | "End" | "Top" | "Right" | "Bottom" | "Left"
    )
}

/// Whether a reference's value fits a property.
pub fn accepts_reference(reference: &Reference, property: &str) -> bool {
    if !reference.contract.variable_set {
        return accepts(&reference.group, property);
    }

    if property.starts_with("--") {
        return true;
    }

    check(reference, &reference.value, property)
}

fn check(reference: &Reference, value: &Value, property: &str) -> bool {
    match value {
        Value::Reference(inner) => accepts_reference(inner, property),
        Value::Composition(expression) => binding::accepts(
            if expression.group.as_deref() == Some("color") {
                Domain::Color
            } else {
                Domain::Length
            },
            property,
        ),
        Value::Record(entries) => entries
            .iter()
            .all(|(_, entry)| check(reference, entry, property)),
        Value::Number(number) => {
            let rule = literal::rule(property);

            match rule {
                Some(rule) if rule.kind == rules::Kind::Number => {
                    // An absent bound compares as `undefined`, which rejects every number.
                    rule.min.is_some_and(|min| *number >= min)
                        && rule.max.is_some_and(|max| *number <= max)
                        && (rule.integer != Some(true) || number.fract() == 0.0)
                }
                Some(rule) if rule.kind == rules::Kind::GridLine => {
                    number.fract() == 0.0 && *number != 0.0
                }
                _ if property == "columns" => number.fract() == 0.0 && *number > 0.0,
                Some(rule) if rule.kind == rules::Kind::Ratio => *number >= 0.0,
                Some(rule) if rule.numeric == Some(true) => {
                    rule.negative == Some(true) || *number >= 0.0
                }
                _ => {
                    binding::accepts(Domain::Number, property)
                        || (*number == 0.0 && binding::accepts(Domain::Length, property))
                }
            }
        }
        Value::String(text) => {
            let rule = literal::rule(property);

            if reference.group == "color" {
                return binding::accepts(Domain::Color, property);
            }

            if reference.group == "spacing" {
                return (rule.is_some_and(|rule| rule.kind == rules::Kind::Compound)
                    && (accepts("spacing", property)
                        || (property == "columns"
                            && !text.ends_with('%')
                            && !text.starts_with('-'))
                        || [
                            "backgroundPosition",
                            "objectPosition",
                            "perspectiveOrigin",
                            "transformOrigin",
                        ]
                        .contains(&property)))
                    || binding::accepts(
                        match (text.ends_with('%'), text.starts_with('-')) {
                            (true, true) => Domain::SignedPercentage,
                            (true, false) => Domain::Percentage,
                            (false, true) => Domain::SignedLength,
                            (false, false) => Domain::Length,
                        },
                        property,
                    );
            }

            literal::is_literal(property, Scalar::String(text))
                || rule.is_some_and(|rule| {
                    matches!(
                        rule.kind,
                        rules::Kind::Compound
                            | rules::Kind::Ratio
                            | rules::Kind::GridLine
                            | rules::Kind::GridTracks
                            | rules::Kind::Identifier
                            | rules::Kind::Rotate
                            | rules::Kind::Scale
                            | rules::Kind::Translate
                    )
                })
        }
    }
}

/// Reads a token tree leaf by dotted path, or by recorded segments for dotted keys.
pub fn leaf<'a>(theme: &'a theme::Definition, path: &str) -> Option<&'a Data> {
    let mut node = &theme.tokens;

    if let Some(parts) = theme
        .metadata
        .paths
        .as_ref()
        .and_then(|paths| paths.get(path))
    {
        for key in parts.iter() {
            node = node.as_object()?.get(key)?;
        }

        return Some(node);
    }

    for key in path.split('.') {
        node = node.as_object()?.get(key)?;
    }

    Some(node)
}

const LEGACY_GROUPS: [&str; 14] = [
    "backgroundColor",
    "borderColor",
    "borderRadius",
    "borderWidth",
    "margin",
    "padding",
    "spacing",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "letterSpacing",
    "lineHeight",
    "textColor",
    "color",
];

/// Resolves a scalar declaration value to a token reference when the theme names it.
///
/// On color properties, an unmatched `name/opacity` value resolves `name` and mixes the color
/// with `transparent`, where `opacity` is a percentage from 0 to 100. Values for custom
/// properties and non-scalars return unchanged.
pub fn resolve(value: &Data, property: &str, theme: &theme::Definition) -> Data {
    let resolved = lookup(value, property, theme);

    let Data::String(text) = value else {
        return resolved;
    };

    if resolved != *value || !accepts("color", property) {
        return resolved;
    }

    let Some((name, opacity)) = text.rsplit_once('/') else {
        return resolved;
    };

    if name.is_empty() || !percentage(opacity) {
        return resolved;
    }

    let amount = crate::js::to_number(opacity);

    if amount > 100.0 {
        return resolved;
    }

    let Data::Token(base) = lookup(&Data::String(Arc::from(name)), property, theme) else {
        return resolved;
    };

    if (base.group != "color" && !base.group.ends_with("Color"))
        || (base.contract.variable_set && !accepts_reference(&base, property))
    {
        return resolved;
    }

    let mut suffix = String::with_capacity(24);

    suffix.push(' ');
    suffix.push_str(&crate::js::number(amount));
    suffix.push_str("%, transparent)");

    // Premultiplied mixing with `transparent` scales the alpha and keeps the channels.
    Data::Expression(compose(vec![
        Part::Text(Arc::from("color-mix(in srgb, ")),
        Part::Reference(base),
        Part::Text(Arc::from(suffix)),
    ]))
}

/// Matches `^(?:\d+(?:\.\d*)?|\.\d+)$`.
fn percentage(text: &str) -> bool {
    let digits = |part: &str| part.bytes().all(|byte| byte.is_ascii_digit());

    match text.split_once('.') {
        Some((whole, fraction)) => {
            (!whole.is_empty() || !fraction.is_empty()) && digits(whole) && digits(fraction)
        }
        None => !text.is_empty() && digits(text),
    }
}

fn lookup(value: &Data, property: &str, theme: &theme::Definition) -> Data {
    let text = match value {
        Data::String(text) if !property.starts_with("--") => text.to_string(),
        Data::Number(number) if !property.starts_with("--") => crate::js::number(*number),
        _ => return value.clone(),
    };
    let data = &theme.metadata;
    let categories = groups::property_groups(property).unwrap_or_default();

    if data.contract.variable_set {
        // The first match in a stable sort by category rank is the earliest match of the lowest
        // rank. Categories the property does not group rank first.
        let mut best: Option<(isize, &Arc<str>, &Value, &str)> = None;

        for (path, entry) in data.values.iter() {
            let (category, rest) = path.split_once('.').unwrap_or((path, ""));
            let matches = match &data.contract.mappings {
                Some(Mappings::Disabled) => **path == *text,
                mappings => {
                    let mapped = match mappings {
                        Some(Mappings::Categories(categories)) => categories.get(category),
                        _ => None,
                    };

                    rest == text
                        && match mapped {
                            Some(properties) => {
                                properties.iter().any(|candidate| &**candidate == property)
                            }
                            None => categories.contains(&category),
                        }
                }
            };

            if !matches {
                continue;
            }

            let rank = categories
                .iter()
                .position(|candidate| *candidate == category)
                .map_or(-1, usize::cast_signed);

            if best.is_none_or(|(lowest, ..)| rank < lowest) {
                best = Some((rank, path, entry, category));
            }
        }

        if let Some((_, path, entry, category)) = best {
            let group = match leaf(theme, path) {
                Some(Data::Token(reference)) => reference.group.clone(),
                _ => Group::from(category),
            };

            return Data::Token(create(
                &data.contract,
                group,
                Arc::clone(path),
                entry.clone(),
            ));
        }

        return value.clone();
    }

    for group in LEGACY_GROUPS {
        if !accepts(group, property) {
            continue;
        }

        let path = format!("{group}.{text}");

        if let Some(entry) = data.values.get(path.as_str()) {
            return Data::Token(create(&data.contract, group, path, entry.clone()));
        }
    }

    value.clone()
}

/// Whether a theme maps tokens to a property, so raw values require `!custom`.
pub fn mapped(theme: &theme::Definition, property: &str) -> bool {
    if property.starts_with("--") {
        return false;
    }

    let data = &theme.metadata;
    let groups = groups::property_groups(property);

    data.values.keys().any(|path| {
        let category = path.split('.').next().unwrap_or_default();

        if !matches!(data.contract.mappings, Some(Mappings::Disabled)) {
            let targets = match &data.contract.mappings {
                Some(Mappings::Categories(categories)) => categories.get(category),
                _ => None,
            };
            let applies = match targets {
                Some(targets) => targets.iter().any(|target| &**target == property),
                None if data.contract.variable_set => {
                    groups.is_some_and(|categories| categories.contains(&category))
                }
                None => accepts(category, property),
            };

            if !applies {
                return false;
            }
        }

        matches!(leaf(theme, path), Some(Data::Token(reference)) if accepts_reference(reference, property))
    })
}

/// Copies a token tree as web variables, which retain `var()` identity in declarations.
pub fn variables(tree: &Data) -> Data {
    match tree {
        Data::Token(reference) => Data::Token(Arc::new(Reference {
            web: true,
            ..(**reference).clone()
        })),
        Data::Object(object) => Data::from(Object::from_entries(
            object
                .iter()
                .map(|(key, value)| (Arc::clone(key), variables(value))),
        )),
        other => other.clone(),
    }
}

/// Rebinds a definition's references to a contract, as `Token.bind` does.
///
/// Internal references owned by the original contract re-resolve against the new one. The class
/// name stays the original's, and `css_name` names generated variables when supplied.
///
/// # Errors
///
/// Returns `Vars.InvalidError` when an internal reference is missing or cyclic.
pub fn bind(
    original: &theme::Definition,
    contract: &Arc<Contract>,
    css_name: Option<&str>,
) -> crate::error::Result<theme::Definition> {
    fn rebind(tree: &Data, contract: &Arc<Contract>, values: &Map<Value>) -> Data {
        match tree {
            Data::Token(reference) => Data::Token(create(
                contract,
                reference.group.clone(),
                Arc::clone(&reference.path),
                values
                    .get(&reference.path)
                    .cloned()
                    .unwrap_or_else(|| reference.value.clone()),
            )),
            Data::Object(object) => {
                Data::from(Object::from_entries(object.iter().map(|(key, value)| {
                    (Arc::clone(key), rebind(value, contract, values))
                })))
            }
            other => other.clone(),
        }
    }

    let metadata = &original.metadata;
    let values = crate::internal::variable_sets::rebind(metadata, contract)?;
    let tokens = rebind(&original.tokens, contract, &values);

    Ok(theme::Definition {
        class_name: theme::ClassName::Fixed(original.class_name().map(Arc::from)),
        metadata: Metadata {
            contract: Arc::clone(contract),
            css_name: css_name
                .map(Arc::from)
                .or_else(|| metadata.css_name.clone()),
            paths: metadata.paths.clone(),
            queries: metadata.queries.clone(),
            values: Arc::new(values),
        },
        vars: variables(&tokens),
        tokens,
    })
}
