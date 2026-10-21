//! Retains ordered finite recipe alternatives independently of an output target.
//!
//! Records keep JavaScript own-property order: callers list entries in the order
//! `Object.entries` returns them.

use std::sync::Arc;

use crate::js;
use crate::style;

/// Ordered axes and their finite choice names.
pub type Axes = Vec<(Arc<str>, Vec<Arc<str>>)>;

/// Default choices by axis, with `None` (`null`) suppressing an axis.
pub type Defaults = Vec<(Arc<str>, Option<Arc<str>>)>;

/// Required choices by axis. An empty list always matches.
pub type Matches = Vec<(Arc<str>, Vec<Arc<str>>)>;

/// One base, choice, or compound rule.
#[derive(Clone, Debug, PartialEq)]
pub struct Rule<V> {
    /// Required choices by axis.
    pub matches: Matches,
    /// Target-independent declarations or their compiled value.
    pub value: V,
}

/// Static recipe data shared by source extraction and target compilers.
#[derive(Clone, Debug, PartialEq)]
pub struct Definition<V = style::Definition> {
    /// Ordered axes and their finite choice names.
    pub axes: Axes,
    /// Default choices.
    pub defaults: Defaults,
    /// Base, choices, and compounds in application order.
    pub rules: Vec<Rule<V>>,
}

/// Appends axes serialized like `JSON.stringify`.
pub fn write_axes(output: &mut String, axes: &Axes) {
    js::write_object(
        output,
        axes.iter().map(|(axis, choices)| (&**axis, choices)),
        |output, choices| write_strings(output, choices),
    );
}

/// Appends defaults serialized like `JSON.stringify`.
pub fn write_defaults(output: &mut String, defaults: &Defaults) {
    js::write_object(
        output,
        defaults.iter().map(|(axis, choice)| (&**axis, choice)),
        |output, choice| match choice {
            Some(choice) => js::write_string(output, choice),
            None => output.push_str("null"),
        },
    );
}

/// Appends compound matches serialized like `JSON.stringify`, as `[axis, choices]` tuples.
pub fn write_matches(output: &mut String, matches: &Matches) {
    output.push('[');

    for (index, (axis, choices)) in matches.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }

        output.push('[');
        js::write_string(output, axis);
        output.push(',');
        write_strings(output, choices);
        output.push(']');
    }

    output.push(']');
}

/// Appends a string list serialized like `JSON.stringify`.
pub fn write_strings(output: &mut String, values: &[Arc<str>]) {
    output.push('[');

    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }

        js::write_string(output, value);
    }

    output.push(']');
}
