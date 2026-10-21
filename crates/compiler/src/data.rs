//! Statically evaluated JavaScript values passed between authoring and compiler stages.
//!
//! Source extraction evaluates literal expressions into [`Data`] without executing code. Plain
//! objects keep JavaScript own-property order, and compiler-owned values such as token references
//! keep their identity through [`std::sync::Arc`] pointers, as frozen objects do in TypeScript.

use std::sync::Arc;

use crate::internal::{binding, theme, token};
use crate::js;

/// A statically known JavaScript value.
#[derive(Clone, Debug, PartialEq)]
pub enum Data {
    /// An array of elements in index order.
    Array(Arc<Vec<Data>>),
    /// A compiler binding reference created by `variable()` or a dynamic slot.
    Binding(Arc<binding::Reference>),
    /// A boolean.
    Bool(bool),
    /// A token composition or interpolated expression.
    Expression(Arc<token::Expression>),
    /// `null`.
    Null,
    /// A number.
    Number(f64),
    /// A plain object with data properties.
    Object(Arc<Object>),
    /// A string.
    String(Arc<str>),
    /// A theme or variable set definition.
    Theme(Arc<theme::Definition>),
    /// A token reference.
    Token(Arc<token::Reference>),
    /// `undefined`.
    Undefined,
}

impl Data {
    /// Creates a string value.
    pub fn string(value: impl Into<Arc<str>>) -> Self {
        Self::String(value.into())
    }

    /// Reads a string value.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(value) => Some(value),
            _ => None,
        }
    }

    /// Reads a number value.
    pub fn as_number(&self) -> Option<f64> {
        match self {
            Self::Number(value) => Some(*value),
            _ => None,
        }
    }

    /// Reads a plain object.
    pub fn as_object(&self) -> Option<&Object> {
        match self {
            Self::Object(value) => Some(value),
            _ => None,
        }
    }

    /// Whether the value is `undefined`.
    pub fn is_undefined(&self) -> bool {
        matches!(self, Self::Undefined)
    }

    /// Whether the value is a string or number, the scalars CSS declarations accept.
    pub fn is_scalar(&self) -> bool {
        matches!(self, Self::String(_) | Self::Number(_))
    }

    /// Whether two values are the same JavaScript value: `===` for primitives, identity for objects.
    pub fn same(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Array(left), Self::Array(right)) => Arc::ptr_eq(left, right),
            (Self::Binding(left), Self::Binding(right)) => Arc::ptr_eq(left, right),
            (Self::Bool(left), Self::Bool(right)) => left == right,
            (Self::Expression(left), Self::Expression(right)) => Arc::ptr_eq(left, right),
            (Self::Null, Self::Null) | (Self::Undefined, Self::Undefined) => true,
            #[expect(
                clippy::float_cmp,
                reason = "JavaScript strict equality compares exact values."
            )]
            (Self::Number(left), Self::Number(right)) => left == right,
            (Self::Object(left), Self::Object(right)) => Arc::ptr_eq(left, right),
            (Self::String(left), Self::String(right)) => left == right,
            (Self::Theme(left), Self::Theme(right)) => Arc::ptr_eq(left, right),
            (Self::Token(left), Self::Token(right)) => Arc::ptr_eq(left, right),
            _ => false,
        }
    }

    /// Converts parsed JSON as `JSON.parse` would, with array-index keys first in objects.
    pub fn from_json(value: &serde_json::Value) -> Self {
        match value {
            serde_json::Value::Null => Self::Null,
            serde_json::Value::Bool(value) => Self::Bool(*value),
            serde_json::Value::Number(number) => Self::Number(number.as_f64().unwrap_or(f64::NAN)),
            serde_json::Value::String(text) => Self::string(text.as_str()),
            serde_json::Value::Array(items) => {
                Self::Array(Arc::new(items.iter().map(Self::from_json).collect()))
            }
            serde_json::Value::Object(object) => {
                Self::from(Object::from_entries(object.iter().map(|(key, value)| {
                    (Arc::from(key.as_str()), Self::from_json(value))
                })))
            }
        }
    }

    /// Converts a scalar like `String(value)`.
    pub fn to_js_string(&self) -> String {
        match self {
            Self::Bool(value) => value.to_string(),
            Self::Null => "null".to_owned(),
            Self::Number(value) => js::number(*value),
            Self::String(value) => value.to_string(),
            Self::Undefined => "undefined".to_owned(),
            Self::Array(items) => items
                .iter()
                .map(|item| {
                    if matches!(item, Self::Null | Self::Undefined) {
                        String::new()
                    } else {
                        item.to_js_string()
                    }
                })
                .collect::<Vec<_>>()
                .join(","),
            _ => "[object Object]".to_owned(),
        }
    }
}

impl From<&str> for Data {
    fn from(value: &str) -> Self {
        Self::String(value.into())
    }
}

impl From<String> for Data {
    fn from(value: String) -> Self {
        Self::String(value.into())
    }
}

impl From<f64> for Data {
    fn from(value: f64) -> Self {
        Self::Number(value)
    }
}

impl From<Object> for Data {
    fn from(value: Object) -> Self {
        Self::Object(Arc::new(value))
    }
}

/// A property value, or the accessor marker that authoring validation rejects.
#[derive(Clone, Debug, PartialEq)]
pub enum Property {
    /// An accessor property, which is never evaluated.
    Accessor,
    /// A data property.
    Value(Data),
}

/// A plain object whose properties enumerate in JavaScript own-property order.
///
/// Array-index keys enumerate first in ascending order, then other keys in insertion order. The
/// order is maintained on insertion, so iteration needs no sorting.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Object {
    entries: Vec<(Arc<str>, Property)>,
    /// Number of leading array-index keys.
    indexes: usize,
    /// Whether the object had a prototype other than `Object.prototype` or `null`.
    pub exotic: bool,
}

impl Object {
    /// Creates an empty plain object.
    pub fn new() -> Self {
        Self::default()
    }

    /// Creates an object from entries, keeping JavaScript own-property order.
    pub fn from_entries(entries: impl IntoIterator<Item = (Arc<str>, Data)>) -> Self {
        let mut object = Self::new();

        for (key, value) in entries {
            object.insert(key, value);
        }

        object
    }

    /// Number of own properties.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the object has no own properties.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Sets a data property. An existing key keeps its position.
    pub fn insert(&mut self, key: impl Into<Arc<str>>, value: Data) {
        self.set(key.into(), Property::Value(value));
    }

    /// Sets an accessor property marker.
    pub fn insert_accessor(&mut self, key: impl Into<Arc<str>>) {
        self.set(key.into(), Property::Accessor);
    }

    /// Inserts a value under a key the object does not hold yet, which skips the search for an
    /// existing property.
    pub fn insert_new(&mut self, key: Arc<str>, value: Data) {
        debug_assert!(!self.has(&key), "the key is new");

        self.place(key, Property::Value(value));
    }

    fn set(&mut self, key: Arc<str>, property: Property) {
        if let Some(entry) = self.entries.iter_mut().find(|(name, _)| *name == key) {
            entry.1 = property;
            return;
        }

        self.place(key, property);
    }

    /// Adds a new property in JavaScript order: array indexes ascending, then insertion order.
    fn place(&mut self, key: Arc<str>, property: Property) {
        match js::array_index(&key) {
            Some(index) => {
                let position = self
                    .entries
                    .get(..self.indexes)
                    .unwrap_or_default()
                    .iter()
                    .position(|(name, _)| js::array_index(name).is_some_and(|other| other > index))
                    .unwrap_or(self.indexes);

                self.entries.insert(position, (key, property));
                self.indexes += 1;
            }
            None => self.entries.push((key, property)),
        }
    }

    /// Removes a property.
    pub fn remove(&mut self, key: &str) -> Option<Property> {
        let position = self.entries.iter().position(|(name, _)| &**name == key)?;

        if position < self.indexes {
            self.indexes -= 1;
        }

        Some(self.entries.remove(position).1)
    }

    /// Reads a data property.
    pub fn get(&self, key: &str) -> Option<&Data> {
        self.entries
            .iter()
            .find(|(name, _)| &**name == key)
            .and_then(|(_, property)| match property {
                Property::Value(value) => Some(value),
                Property::Accessor => None,
            })
    }

    /// Whether the object has an own property, like `Object.hasOwn`.
    pub fn has(&self, key: &str) -> bool {
        self.entries.iter().any(|(name, _)| &**name == key)
    }

    /// Iterates own properties in JavaScript order.
    pub fn properties(&self) -> impl Iterator<Item = (&Arc<str>, &Property)> {
        self.entries.iter().map(|(key, property)| (key, property))
    }

    /// Iterates own data properties in JavaScript order, skipping accessors.
    pub fn iter(&self) -> impl Iterator<Item = (&Arc<str>, &Data)> {
        self.entries
            .iter()
            .filter_map(|(key, property)| match property {
                Property::Value(value) => Some((key, value)),
                Property::Accessor => None,
            })
    }

    /// Iterates own keys in JavaScript order.
    pub fn keys(&self) -> impl Iterator<Item = &Arc<str>> {
        self.entries.iter().map(|(key, _)| key)
    }
}
