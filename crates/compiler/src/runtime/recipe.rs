//! Runtime recipe selection data the compiler emits for `variants`.

use std::sync::Arc;

use crate::js::Record;

/// A scalar payload value.
#[derive(Clone, Debug, PartialEq)]
pub enum Scalar {
    /// A number.
    Number(f64),
    /// A string.
    String(Arc<str>),
}

/// Slot names a choice's payload fields bind.
#[derive(Clone, Debug, PartialEq)]
pub struct Payload {
    /// Axis name.
    pub axis: Arc<str>,
    /// Choice name.
    pub choice: Arc<str>,
    /// Custom property names by field, one record per payload application.
    pub slots: Vec<Record<Arc<str>>>,
}

/// Selection metadata for a compiled recipe.
#[derive(Clone, Debug)]
pub struct Definition {
    /// Choices of each axis.
    pub axes: Record<Vec<Arc<str>>>,
    /// Condition names, for conditional recipes.
    pub conditions: Option<Vec<Arc<str>>>,
    /// Default payload values by axis and field.
    pub default_payloads: Option<Record<Record<Scalar>>>,
    /// Default choice of each axis.
    pub defaults: Record<Option<Arc<str>>>,
    /// Payload slot bindings.
    pub payloads: Option<Vec<Payload>>,
}
