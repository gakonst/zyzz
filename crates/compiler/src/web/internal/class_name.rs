//! Names atomic declarations with readable values and scoped conflict identities.
//!
//! The unit registry shares declaration-unit names across the compilations of one graph. It is a
//! plain value owned by the graph: each compilation borrows it through a [`Units`] scope, and a
//! cached compilation registers its recorded decisions with [`Registry::restore`].

use std::borrow::Cow;
use std::fmt::Write as _;
use std::sync::Arc;

use indexmap::IndexMap;
use rustc_hash::{FxBuildHasher, FxHashMap, FxHashSet};

use crate::internal::literal;
use crate::js;

/// Inputs for [`create`]. A context retains declaration ordering and module ownership.
#[derive(Clone, Copy, Debug, Default)]
pub struct CreateOptions<'a> {
    /// Complete declaration, including fallbacks and conditions.
    pub body: &'a str,
    /// Identity required when the declaration cannot share a global rule.
    pub context: Option<&'a str>,
    /// Optional consumer-owned configuration namespace.
    pub namespace: Option<&'a str>,
    /// Authoring property spelling.
    pub property: &'a str,
    /// Module identity of a shared declaration. Each module delivers its own stylesheet, so a
    /// rule named alike in two modules would take the cascade position of the later one.
    pub qualifier: Option<&'a str>,
    /// Ordered declaration slot inside a contextual style.
    pub slot: Option<usize>,
}

/// Readable property prefixes for common declarations.
const ALIASES: [(&str, &str); 15] = [
    ("backgroundColor", "bg"),
    ("color", "text"),
    ("height", "h"),
    ("margin", "m"),
    ("marginBottom", "mb"),
    ("marginLeft", "ml"),
    ("marginRight", "mr"),
    ("marginTop", "mt"),
    ("opacity", "opacity"),
    ("padding", "p"),
    ("paddingBottom", "pb"),
    ("paddingLeft", "pl"),
    ("paddingRight", "pr"),
    ("paddingTop", "pt"),
    ("width", "w"),
];

/// Flex and grid also name shorthand properties, so these keep their display prefix only when
/// absent from this list.
const DISPLAYS: [&str; 6] = [
    "block",
    "inline",
    "inline-block",
    "inline-flex",
    "inline-grid",
    "none",
];

/// Interaction states named in readable atomic identities.
const STATES: [&str; 5] = ["hover", "focus", "focus-visible", "active", "disabled"];

/// Creates a CSS identifier without embedding arbitrary CSS syntax.
pub fn create(options: &CreateOptions<'_>) -> String {
    let property: Cow<'_, str> = ALIASES
        .iter()
        .find(|(name, _)| *name == options.property)
        .map_or_else(
            || Cow::Owned(literal::name(options.property)),
            |(_, alias)| Cow::Borrowed(*alias),
        );
    let namespace = options.namespace.filter(|namespace| !namespace.is_empty());
    let mut output = String::with_capacity(options.body.len() + 16);

    output.push_str("z-");

    if let Some(namespace) = namespace {
        output.push_str(namespace);
        output.push('-');
    }

    if let Some(context) = options.context {
        output.push_str(context);
        output.push('-');
        encode_into(&mut output, &property);

        if let Some(slot) = options.slot {
            let _ = write!(output, "-{slot}");
        }

        return output;
    }

    if let Some(qualifier) = options.qualifier.filter(|qualifier| !qualifier.is_empty()) {
        output.push_str(qualifier);
        output.push('-');
    }

    let condition = state(options.body);
    let body = condition.map_or(options.body, |(_, inner)| inner);
    let name = literal::name(options.property);
    let value = body
        .strip_prefix(name.as_str())
        .and_then(|rest| rest.strip_prefix(':'))
        .filter(|_| body.ends_with(';'))
        .map_or("", |rest| {
            rest.get(..rest.len().saturating_sub(1)).unwrap_or_default()
        });
    let simple = (1..=24).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    let fallback = if value.is_empty() { body } else { value };

    if let Some((state, _)) = condition {
        output.push_str(state);
        output.push('-');
    }

    if options.property == "display" && DISPLAYS.contains(&value) {
        escape_into(&mut output, value);
    } else if property.starts_with("--") {
        escape_into(&mut output, "[");
        escape_into(&mut output, &property);
        escape_into(&mut output, ":");
        escape_into(&mut output, fallback);
        escape_into(&mut output, "]");
    } else {
        escape_into(&mut output, &property);
        output.push('-');

        if simple {
            escape_into(&mut output, value);
        } else {
            output.push('[');
            escape_into(&mut output, fallback);
            output.push(']');
        }
    }

    output
}

/// Matches `^&:(hover|focus|focus-visible|active|disabled)\{([^{}]+)\}$`.
fn state(body: &str) -> Option<(&'static str, &str)> {
    let rest = body.strip_prefix("&:")?;
    let (state, rest) = STATES.iter().find_map(|state| {
        rest.strip_prefix(state)
            .and_then(|rest| rest.strip_prefix('{'))
            .map(|rest| (*state, rest))
    })?;
    let inner = rest.strip_suffix('}')?;

    (!inner.is_empty() && !inner.contains(['{', '}'])).then_some((state, inner))
}

/// Replaces whitespace, underscores, quotes, and angle brackets with `_<hex>_`, which DOM class
/// tokens cannot otherwise contain reversibly.
fn escape_into(output: &mut String, value: &str) {
    for character in value.chars() {
        if js::is_whitespace(character) || matches!(character, '_' | '"' | '\'' | '<' | '>') {
            let _ = write!(output, "_{:x}_", u32::from(character));
        } else {
            output.push(character);
        }
    }
}

/// Encodes every UTF-16 code unit other than ASCII letters, digits, and `-` as `_<hex>_`, which
/// makes the encoded form injective.
pub(crate) fn encode_into(output: &mut String, value: &str) {
    if value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        output.push_str(value);
        return;
    }

    for character in value.chars() {
        if character.is_ascii_alphanumeric() || character == '-' {
            output.push(character);
            continue;
        }

        let mut units = [0_u16; 2];

        for unit in character.encode_utf16(&mut units) {
            let _ = write!(output, "_{unit:x}_");
        }
    }
}

/// Encodes a value like [`encode_into`].
pub(crate) fn encode(value: &str) -> String {
    let mut output = String::with_capacity(value.len());

    encode_into(&mut output, value);

    output
}

/// Escapes a generated class token for use as a CSS selector.
pub fn selector(value: &str) -> Cow<'_, str> {
    if value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Cow::Borrowed(value);
    }

    let mut output = String::with_capacity(value.len() + 8);

    for character in value.chars() {
        if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
            output.push(character);
        } else {
            let _ = write!(output, "\\{:x} ", u32::from(character));
        }
    }

    Cow::Owned(output)
}

/// A naming decision recorded so cached output can be validated against a later build.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Decision {
    /// Whether the name was introduced by an earlier compilation.
    pub borrowed: bool,
    /// Emitted class name.
    pub name: String,
}

/// Decisions keyed by namespace and body, in the order a compilation made them.
pub type Used = IndexMap<Box<str>, Decision, FxBuildHasher>;

/// Which owners' names a compilation may reuse.
#[derive(Clone, Debug, Default)]
pub enum Visibility {
    /// Names introduced by every owner, as in a graph compiled once with every module.
    #[default]
    All,
    /// Names introduced by these owners only. Graphs share one set per module closure.
    Owners(Arc<FxHashSet<Arc<str>>>),
}

impl Visibility {
    fn includes(&self, owner: &str) -> bool {
        match self {
            Self::All => true,
            Self::Owners(owners) => owners.contains(owner),
        }
    }
}

/// A registered unit name and the compilation that introduced it.
#[derive(Clone, Debug)]
struct Entry {
    name: Box<str>,
    owner: Box<str>,
}

/// Shares unit names across the compilations of one graph.
#[derive(Clone, Debug, Default)]
pub struct Registry {
    names: FxHashMap<Box<str>, Entry>,
}

impl Registry {
    /// Creates an empty name table.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a name as introduced by an owner, as an earlier compilation in this table would.
    pub fn insert(&mut self, key: &str, name: &str, owner: &str) {
        self.names.entry(key.into()).or_insert_with(|| Entry {
            name: name.into(),
            owner: owner.into(),
        });
    }

    /// A borrowed name stays tied to its first owner, so later modules can resolve it.
    fn borrow(&self, key: &str, visible: &Visibility) -> Option<&str> {
        self.names
            .get(key)
            .filter(|entry| visible.includes(&entry.owner))
            .map(|entry| &*entry.name)
    }

    /// Registers a cached compilation's names. Returns false, registering nothing, when compiling
    /// it now would choose different names.
    pub fn restore(&mut self, owner: &str, used: &Used, visible: &Visibility) -> bool {
        for (key, decision) in used {
            let name = self.borrow(key, visible);

            if name.is_some() != decision.borrowed {
                return false;
            }

            if name.is_some_and(|name| name != decision.name) {
                return false;
            }
        }

        for (key, decision) in used {
            self.insert(key, &decision.name, owner);
        }

        true
    }

    /// Names units for one compilation, whose qualifier keeps new names distinct.
    pub fn scope(&mut self, owner: &str, qualifier: &str, visible: Visibility) -> Units<'_> {
        Units {
            owner: owner.into(),
            qualifier: qualifier.into(),
            registry: self,
            used: Used::default(),
            visible,
        }
    }
}

/// One compilation's unit names over a borrowed registry.
#[derive(Debug)]
pub struct Units<'a> {
    owner: Box<str>,
    qualifier: Box<str>,
    registry: &'a mut Registry,
    used: Used,
    visible: Visibility,
}

impl Units<'_> {
    /// Names a declaration unit, reusing a visible earlier name for an equal body. The key is
    /// the namespace and the body joined by a line break.
    pub fn name(&mut self, key: &str, namespace: Option<&str>) -> String {
        // A repeated body keeps its name. Its first naming registered it, so a visible registry
        // now reports the name as borrowed, as a fresh lookup would.
        if let Some(decision) = self.used.get_mut(key) {
            decision.borrowed = self.registry.borrow(key, &self.visible).is_some();

            return decision.name.clone();
        }

        // Every distinct body consumes a slot, so own names never depend on reuse.
        let index = self.used.len();
        let borrowed = self.registry.borrow(key, &self.visible).map(str::to_owned);
        let is_borrowed = borrowed.is_some();
        // The underscore keeps unit names apart from readable names and anonymous scopes.
        let name = borrowed.unwrap_or_else(|| {
            let mut name = String::with_capacity(16);

            name.push_str("z_");

            if let Some(namespace) = namespace.filter(|namespace| !namespace.is_empty()) {
                name.push_str(namespace);
                name.push('-');
            }

            name.push_str(&self.qualifier);
            name.push_str(&js::radix(index as u64, 36));
            name
        });

        self.registry.insert(key, &name, &self.owner);
        self.used.insert(
            key.into(),
            Decision {
                borrowed: is_borrowed,
                name: name.clone(),
            },
        );

        name
    }

    /// Module qualifier that keeps this compilation's new names distinct.
    pub fn qualifier(&self) -> &str {
        &self.qualifier
    }

    /// Names chosen so far, keyed by namespace and body, and whether each was reused.
    pub fn used(&self) -> &Used {
        &self.used
    }
}
