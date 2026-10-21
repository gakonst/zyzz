//! Decodes `Css.compile` input from, and encodes its result into, one JSON string.
//!
//! JavaScript callers pass frozen definitions whose contracts, token references, expressions,
//! bindings, and theme metadata compare by object identity. The wire format keeps that identity
//! with one post-order `objects` table: each JavaScript object appears once, earlier entries
//! never refer to later ones, and every use refers to it by index. Decoding shares one
//! [`Arc`] per entry, so `Arc::ptr_eq` matches JavaScript identity exactly.
//!
//! # Input
//!
//! ```text
//! Input        := { "objects"?: [Object], "strings"?: [string], "styles": [Style],
//!                   "contributions"?: [Contribution],
//!                   "labels"?: [[style, name | null, namespace | null]], "names"?: [[style, id]],
//!                   "vars"?: [[name, index | false | null]], "units"?: Units,
//!                   "composition"?: Mode, "cssOutput"?: Mode, "development"?: bool,
//!                   "schemes"?: bool, "scope"?: string, "shared"?: "all" | "defaults" }
//! Object       := ["c", Contract] | ["b", name, type, dynamic]
//!               | ["t", contract, group, path, Value, web] | ["e", group | null, [Part]]
//!               | ["m", contract, cssName | null, [[path, Value]], paths | null, queries | null]
//! Contract     := { "keys": [name], "complete"?: bool, "identity"?: string,
//!                   "variableSet"?: bool, "mappings"?: false | {category: [property]},
//!                   "composition"?: string, "cssOutput"?: string, "defaultLayer"?: string,
//!                   "shorthands"?: {name: [property]} }
//! Value        := string | number | [index] | {"n": "NaN" | "Infinity" | "-Infinity"}
//!               | {"r": [[key, Value]]}                      (token values only)
//! Part         := string | [index]
//! Style        := { "n": name, "d": [property, value, flags, ...], "r"?: [[condition | null, Style]],
//!                   "o"?: Mode, "c"?: Mode, "t"?: {"native"?, "ios"?, "android"?: JSON,
//!                   "web"?: Style} }
//! Mode         := string | false
//! Units        := { "owner": string, "qualifier": string, "visible": [owner] | null,
//!                   "names": [[key, name, owner]] }
//! ```
//!
//! Declarations are flat triples, which keep the hot path free of string parsing. `property` is
//! an index into `strings`. Bit 0 of `flags` marks `!important`, and `flags >> 1` selects the
//! value kind: 0 for a string index, 1 for a finite number, 2 for an object index, and 3 for a
//! non-finite number (`0` for `NaN`, `1` for `Infinity`, `-1` for `-Infinity`).
//!
//! `objects` and `strings` precede `styles`, which decodes in place against them.
//!
//! Native compilation reads only `vars` from the same input, through [`definitions`], so a host
//! encodes its native sets as it encodes `Css.compile` scopes, with an empty `styles` list.
//!
//! Objects, records, and option lists keep JavaScript own-property order, which already lists
//! array-index keys first. `Mode` carries an own property's raw value: `false` stands for a
//! present non-string value. `vars` entries name a metadata object, `false` for a value without
//! definition metadata, or `null` for `null` and `undefined`. Contributions keep the TypeScript
//! shapes with a `kind` tag; their styles use `Style`, and their descriptor records become
//! `[[key, scalar]]` lists. `units` snapshots a TypeScript-owned registry: every registered name,
//! the scope's owner and qualifier, and the owners it may borrow from, or `null` for all.
//!
//! # Output
//!
//! ```text
//! Output := { "classes": {name: class}, "css": string, "vars": {name: class},
//!             "contributionCss"?: string, "scopedCss"?: string, "rules": {identity: body},
//!             "units": [[key, borrowed, name]], "shared"?: [Resource] }
//!         | { "error": { "name": string, "message": string, "diagnostics"?: [Diagnostic] } }
//! Resource := { "css": string, "id": string, "rules"?: [Rule] }
//! Rule := { "conditions": [string], "property": string, "selector": string, "value": string }
//! Diagnostic := { "code": string, "message": string, "path": [string] }
//! ```

use std::borrow::Cow;
use std::fmt;
use std::marker::PhantomData;
use std::sync::Arc;

use rustc_hash::{FxHashMap, FxHashSet};
use serde::Deserialize;
use serde::de::{self, DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor};

use crate::data::{Data, Object};
use crate::error::{Error, Result};
use crate::internal::binding::{self, Domain};
use crate::internal::token::{
    self, Composition, Contract, ContractKey, CssOutput, Expression, Mappings, Metadata, Part,
    Reference,
};
use crate::internal::{query, theme};
use crate::js;
use crate::style::{self, Declaration, Label, Labels, NamedStyle, Rule, Targets};
use crate::web::css::{self, Names, Output};
use crate::web::internal::block::Entry;
use crate::web::internal::class_name::{Registry, Visibility};
use crate::web::internal::contributions::{self, ImportLayer, Kind, Scalar};
use crate::web::internal::namespace;
use crate::web::internal::themes::{Resource, Scope, Shared};

/// A decoded unit naming scope over a snapshot of its registry.
#[derive(Debug)]
pub struct UnitScope {
    /// Compilation identity recorded on the names it introduces.
    pub owner: Arc<str>,
    /// Fixed prefix distinguishing this compilation's new names.
    pub qualifier: Arc<str>,
    /// Registered names from earlier compilations.
    pub registry: Registry,
    /// Owners whose names this compilation may reuse.
    pub visible: Visibility,
}

/// Decoded `Css.compile` input that owns every definition.
#[derive(Debug, Default)]
pub struct Input {
    /// Composition for styles without their own mode.
    pub composition: Option<Composition>,
    /// Stylesheet contributions.
    pub contributions: Vec<contributions::Definition>,
    /// Default CSS representation.
    pub css_output: Option<CssOutput>,
    /// Development naming.
    pub development: bool,
    /// Readable names per style.
    pub labels: Option<Labels>,
    /// Fixed class identities.
    pub names: Option<Names>,
    /// Emits scheme selection classes.
    pub schemes: bool,
    /// Consumer-owned namespace.
    pub scope: Option<Arc<str>>,
    /// Separated token rules.
    pub shared: Option<Shared>,
    /// Ordered named styles.
    pub styles: Vec<Arc<NamedStyle>>,
    /// Unit naming scope, when the caller supplied one.
    pub units: Option<UnitScope>,
    /// Named theme scopes.
    pub vars: Option<Vec<(Arc<str>, Scope)>>,
}

impl Input {
    /// Borrows the input as compiler options.
    pub fn options(&self) -> css::Options<'_> {
        css::Options {
            composition: self.composition,
            contributions: &self.contributions,
            contributions_only: false,
            css_output: self.css_output,
            deferred_scopes: false,
            development: self.development,
            labels: self.labels.as_ref(),
            names: self.names.as_ref(),
            schemes: self.schemes,
            scope: self.scope.as_deref(),
            shared: self.shared,
            styles: &self.styles,
            vars: self.vars.as_deref(),
        }
    }

    /// Compiles the decoded input, naming units in its supplied scope when present.
    ///
    /// # Errors
    ///
    /// Returns the [`css::compile`] errors.
    pub fn compile(&mut self) -> Result<Output> {
        let Self { units, .. } = self;
        let mut scope = units.take();
        let options = self.options();
        let result = match &mut scope {
            Some(scope) => {
                let mut units = scope.registry.scope(
                    &scope.owner,
                    &scope.qualifier,
                    std::mem::take(&mut scope.visible),
                );

                css::compile(&options, Some(&mut units))
            }
            None => css::compile(&options, None),
        };

        self.units = scope;
        result
    }
}

/// Decodes, compiles, and encodes one `Css.compile` call, reporting failures as error JSON.
pub fn compile(input: &str) -> String {
    let result = decode(input).and_then(|mut input| input.compile());

    encode(&result)
}

#[cold]
fn malformed(message: impl fmt::Display) -> Error {
    Error::message(format!("Invalid compiler wire input: {message}"))
}

/// Decodes wire input.
///
/// # Errors
///
/// Returns a plain error for malformed JSON, and `Css.CompileError` for an output mode that is
/// neither atomic nor grouped, matching the first diagnostic `Css.compile` reports.
pub fn decode(input: &str) -> Result<Input> {
    let (mut decoder, raw) = read(input)?;
    let styles = raw.styles;

    let css_output = match &raw.css_output {
        None => None,
        Some(mode) => Some(
            mode.output()
                .ok_or_else(|| css::invalid_output(vec!["cssOutput".into()]))?,
        ),
    };

    if let Some(path) = decoder.invalid.take() {
        return Err(css::invalid_output(path));
    }

    let mut contributions = Vec::with_capacity(raw.contributions.len());

    for contribution in raw.contributions {
        contributions.push(decoder.contribution(contribution)?);
    }

    let vars = match raw.vars {
        None => None,
        Some(entries) => {
            let mut vars = Vec::with_capacity(entries.len());

            for (name, reference) in entries {
                let scope = match reference {
                    ThemeReference::Index(index) => match decoder.objects.get(index) {
                        Some(Resolved::Theme(metadata)) => Scope::Definition(metadata.clone()),
                        _ => return Err(malformed("vars must refer to theme metadata")),
                    },
                    ThemeReference::Invalid => Scope::Invalid,
                    ThemeReference::Nullish => Scope::Nullish,
                };

                vars.push((name, scope));
            }

            Some(vars)
        }
    };
    let units = raw.units.map(|units| {
        let mut registry = Registry::new();

        for (key, name, owner) in &units.names {
            registry.insert(key, name, owner);
        }

        UnitScope {
            owner: units.owner,
            qualifier: units.qualifier,
            registry,
            visible: match units.visible {
                None => Visibility::All,
                Some(owners) => Visibility::Owners(Arc::new(
                    owners
                        .into_iter()
                        .map(|owner| Arc::from(owner.as_ref()))
                        .collect::<FxHashSet<Arc<str>>>(),
                )),
            },
        }
    });

    Ok(Input {
        composition: raw.composition.as_ref().map(RawMode::composition),
        contributions,
        css_output,
        development: raw.development,
        labels: raw.labels.map(|labels| {
            labels
                .into_iter()
                .filter_map(|(style, name, namespace)| {
                    Some((
                        style,
                        Label {
                            name: name?,
                            namespace,
                        },
                    ))
                })
                .collect()
        }),
        names: raw.names.map(|names| names.into_iter().collect()),
        schemes: raw.schemes,
        scope: raw.scope,
        shared: raw.shared.as_deref().map(|shared| {
            if shared == "all" {
                Shared::All
            } else {
                Shared::Defaults
            }
        }),
        styles,
        units,
        vars,
    })
}

/// A labeled `vars` entry, `None` for a value without definition metadata.
pub type Set = (Arc<str>, Option<Arc<theme::Definition>>);

/// Decodes the `vars` of wire input as set definitions for native compilation.
///
/// Entries that name the same metadata object share one definition, so identity comparisons
/// match the JavaScript values the encoder read. Entries without definition metadata decode as
/// `None`. The other input fields are read and ignored.
///
/// # Errors
///
/// Returns a plain error for malformed JSON or a `vars` entry that names no metadata object.
pub fn definitions(input: &str) -> Result<Vec<Set>> {
    let (decoder, raw) = read(input)?;
    let mut shared: FxHashMap<usize, Arc<theme::Definition>> = FxHashMap::default();
    let mut definitions = Vec::new();

    for (name, reference) in raw.vars.unwrap_or_default() {
        let definition = match reference {
            ThemeReference::Index(index) => {
                if let Some(definition) = shared.get(&index) {
                    Some(Arc::clone(definition))
                } else {
                    let Some(Resolved::Theme(metadata)) = decoder.objects.get(index) else {
                        return Err(malformed("vars must refer to theme metadata"));
                    };
                    // Native compilation reads only the metadata of a set.
                    let definition = Arc::new(theme::Definition {
                        class_name: theme::ClassName::Contract,
                        metadata: metadata.clone(),
                        tokens: Data::Undefined,
                        vars: Data::Undefined,
                    });

                    shared.insert(index, Arc::clone(&definition));
                    Some(definition)
                }
            }
            ThemeReference::Invalid | ThemeReference::Nullish => None,
        };

        definitions.push((name, definition));
    }

    Ok(definitions)
}

/// Reads the tables and top-level fields of wire input.
fn read(input: &str) -> Result<(Decoder, RawInput<'_>)> {
    let mut decoder = Decoder {
        invalid: None,
        objects: Vec::new(),
        shared: FxHashSet::default(),
        table: Vec::new(),
    };
    let mut deserializer = serde_json::Deserializer::from_str(input);
    let raw = InputSeed {
        decoder: &mut decoder,
    }
    .deserialize(&mut deserializer)
    .map_err(malformed)?;

    deserializer.end().map_err(malformed)?;

    Ok((decoder, raw))
}

/// A resolved identity table entry.
#[derive(Clone, Debug)]
enum Resolved {
    Binding(Arc<binding::Reference>),
    Contract(Arc<Contract>),
    Expression(Arc<Expression>),
    Theme(Metadata),
    Token(Arc<Reference>),
}

struct Decoder {
    /// Path of the first invalid output mode, in `Css.compile` validation order.
    invalid: Option<Vec<Arc<str>>>,
    objects: Vec<Resolved>,
    /// Shares repeated conditions and token values.
    shared: FxHashSet<Arc<str>>,
    /// The input string table.
    table: Vec<Arc<str>>,
}

impl Decoder {
    fn intern(&mut self, text: Text<'_>) -> Arc<str> {
        if let Some(shared) = self.shared.get(&*text.0) {
            return Arc::clone(shared);
        }

        let shared: Arc<str> = text.0.into();

        self.shared.insert(Arc::clone(&shared));
        shared
    }

    fn contract(&self, index: usize) -> Result<Arc<Contract>> {
        match self.objects.get(index) {
            Some(Resolved::Contract(contract)) => Ok(Arc::clone(contract)),
            _ => Err(malformed(format_args!("object {index} is not a contract"))),
        }
    }

    fn object(&mut self, object: RawObject<'_>) -> Result<Resolved> {
        Ok(match object {
            RawObject::Binding(name, kind, dynamic) => {
                Resolved::Binding(Arc::new(binding::Reference {
                    domain: Domain::parse(&kind)
                        .ok_or_else(|| malformed(format_args!("unknown binding type {kind}")))?,
                    dynamic,
                    name: name.to_string(),
                    // Only compiler-extracted callback slots accept zero for empty strings.
                    zero: false,
                }))
            }
            RawObject::Contract(raw) => Resolved::Contract(Arc::new(Contract {
                complete: raw.complete,
                composition: raw.composition.as_deref().and_then(Composition::parse),
                css_output: raw.css_output.as_deref().and_then(CssOutput::parse),
                default_layer: raw.default_layer,
                identity: raw.identity,
                keys: Some(
                    raw.keys
                        .iter()
                        .filter_map(|key| ContractKey::parse(key))
                        .collect(),
                ),
                mappings: match raw.mappings {
                    None => None,
                    Some(RawMappings::Disabled) => Some(Mappings::Disabled),
                    Some(RawMappings::Categories(categories)) => {
                        Some(Mappings::Categories(lists(categories)))
                    }
                },
                shorthands: raw.shorthands.map(lists),
                variable_set: raw.variable_set,
            })),
            RawObject::Expression(group, parts) => {
                let mut values = Vec::with_capacity(parts.len());

                for part in parts {
                    values.push(match part {
                        RawPart::Text(text) => Part::Text(text),
                        RawPart::Reference(index) => match self.objects.get(index) {
                            Some(Resolved::Token(reference)) => {
                                Part::Reference(Arc::clone(reference))
                            }
                            Some(Resolved::Binding(binding)) => Part::Binding(Arc::clone(binding)),
                            _ => return Err(malformed("expression parts must be references")),
                        },
                    });
                }

                Resolved::Expression(Arc::new(Expression {
                    group: group.map(|group| token::Group::from(&*group)),
                    parts: values,
                }))
            }
            RawObject::Theme(contract, css_name, values, paths, queries) => {
                let mut map = token::Map::default();

                for (path, value) in values {
                    let value = self.token_value(value)?;

                    map.insert(path, value);
                }

                Resolved::Theme(Metadata {
                    contract: self.contract(contract)?,
                    css_name,
                    paths: paths.map(lists),
                    queries: queries.map(|queries| {
                        Arc::new(query::Metadata {
                            breakpoint: queries.breakpoint.into_iter().collect(),
                            container: queries.container.into_iter().collect(),
                            container_names: queries.container_names,
                        })
                    }),
                    values: Arc::new(map),
                })
            }
            RawObject::Token(contract, group, path, value, web) => {
                let contract = self.contract(contract)?;
                let value = self.token_value(value)?;

                Resolved::Token(Arc::new(Reference {
                    contract,
                    group: token::Group::from(&*group),
                    path,
                    value,
                    web,
                }))
            }
        })
    }

    fn token_value(&mut self, value: RawValue<'_>) -> Result<token::Value> {
        Ok(match value {
            RawValue::Number(number) => token::Value::Number(number),
            RawValue::String(text) => token::Value::String(self.intern(text)),
            RawValue::Reference(index) => match self.objects.get(index) {
                Some(Resolved::Token(reference)) => token::Value::Reference(Arc::clone(reference)),
                Some(Resolved::Expression(expression)) => {
                    token::Value::Composition(Arc::clone(expression))
                }
                _ => {
                    return Err(malformed(
                        "token values must refer to tokens or compositions",
                    ));
                }
            },
            RawValue::Record(entries) => {
                let mut record = Vec::with_capacity(entries.len());

                for (key, entry) in entries {
                    let entry = self.token_value(entry)?;

                    record.push((key, entry));
                }

                token::Value::Record(record.into())
            }
        })
    }

    fn string(&self, index: f64) -> Result<Arc<str>> {
        index_of(index)
            .and_then(|index| self.table.get(index))
            .cloned()
            .ok_or_else(|| malformed(format_args!("string {index} is out of range")))
    }

    /// Converts one flat declaration triple.
    fn declaration(&self, property: f64, value: f64, flags: f64) -> Result<Declaration> {
        let flags = index_of(flags)
            .and_then(|flags| u8::try_from(flags).ok())
            .ok_or_else(|| malformed("declaration flags must be small integers"))?;

        Ok(Declaration {
            important: flags & 1 == 1,
            property: self.string(property)?,
            value: self.declaration_value(flags >> 1, value)?,
        })
    }

    fn declaration_value(&self, kind: u8, value: f64) -> Result<style::Value> {
        Ok(match kind {
            0 => style::Value::String(self.string(value)?),
            1 => style::Value::Number(value),
            2 => match index_of(value).and_then(|index| self.objects.get(index)) {
                Some(Resolved::Token(reference)) => style::Value::Token(Arc::clone(reference)),
                Some(Resolved::Expression(expression)) => {
                    style::Value::Expression(Arc::clone(expression))
                }
                Some(Resolved::Binding(binding)) => style::Value::Binding(Arc::clone(binding)),
                _ => return Err(malformed("declaration values must refer to values")),
            },
            _ => style::Value::Number(if value > 0.0 {
                f64::INFINITY
            } else if value < 0.0 {
                f64::NEG_INFINITY
            } else {
                f64::NAN
            }),
        })
    }

    /// Converts a style. Compiled styles validate their own mode before their rules and web
    /// branch, as `Css.compile` does after selecting web targets.
    fn style(&mut self, raw: RawStyle<'_>, validate: bool) -> Result<Arc<NamedStyle>> {
        let css_output = match &raw.css_output {
            None => None,
            Some(mode) => {
                let output = mode.output();

                if output.is_none() && validate && self.invalid.is_none() {
                    self.invalid = Some(vec![Arc::clone(&raw.name), "cssOutput".into()]);
                }

                output
            }
        };
        let mut declarations = Vec::with_capacity(raw.declarations.len() / 3);

        for triple in raw.declarations.chunks(3) {
            let &[property, value, flags] = triple else {
                return Err(malformed("declarations must be triples"));
            };

            declarations.push(self.declaration(property, value, flags)?);
        }

        let rules = match raw.rules {
            None => None,
            Some(rules) => {
                let mut output = Vec::with_capacity(rules.len());

                for (condition, style) in rules {
                    output.push(Rule {
                        condition: condition.map(|condition| self.intern(condition)),
                        style: self.style(style, validate)?,
                    });
                }

                Some(output)
            }
        };
        let targets = match raw.targets {
            None => None,
            Some(targets) => Some(Targets {
                android: targets.android.map(|data| data.0),
                ios: targets.ios.map(|data| data.0),
                native: targets.native.map(|data| data.0),
                order: Vec::new(),
                web: match targets.web {
                    None => None,
                    Some(web) => Some(self.style(*web, validate)?),
                },
            }),
        };

        Ok(Arc::new(NamedStyle {
            composition: raw.composition.as_ref().map(RawMode::composition),
            css_output,
            declarations,
            name: raw.name,
            rules,
            targets,
        }))
    }

    fn entry(&mut self, raw: RawEntry<'_>) -> Result<Entry> {
        Ok(match raw {
            RawEntry::Block { entries, header } => {
                let mut output = Vec::with_capacity(entries.len());

                for entry in entries {
                    output.push(self.entry(entry)?);
                }

                Entry::Block {
                    entries: output,
                    header,
                }
            }
            RawEntry::Descriptor { name, value } => Entry::Descriptor {
                name,
                value: value.into(),
            },
            RawEntry::Style { style } => Entry::Style(self.style(*style, false)?),
        })
    }

    fn contribution(&mut self, raw: RawContribution<'_>) -> Result<contributions::Definition> {
        let kind = match raw.kind {
            RawKind::Block { entries, header } => {
                let mut output = Vec::with_capacity(entries.len());

                for entry in entries {
                    output.push(self.entry(entry)?);
                }

                Kind::Block {
                    entries: output,
                    header,
                }
            }
            RawKind::CustomMedia { name, query } => Kind::CustomMedia { name, query },
            RawKind::Descriptor {
                declarations,
                name,
                rule,
            } => Kind::Descriptor {
                declarations: scalars(declarations),
                name,
                rule,
            },
            RawKind::FontFace { declarations } => Kind::FontFace {
                declarations: scalars(declarations),
            },
            RawKind::Import {
                layer,
                media,
                supports,
                url,
            } => Kind::Import {
                layer: match layer {
                    Some(RawLayer::Anonymous(true)) => Some(ImportLayer::Anonymous),
                    Some(RawLayer::Named(name)) if !name.is_empty() => {
                        Some(ImportLayer::Named(name))
                    }
                    _ => None,
                },
                media: media.filter(|media| !media.is_empty()),
                supports: supports.filter(|supports| !supports.is_empty()),
                url,
            },
            RawKind::Keyframes { frames, name } => {
                let mut output = Vec::with_capacity(frames.len());

                for (stop, style) in frames {
                    output.push((stop, self.style(style, false)?));
                }

                Kind::Keyframes {
                    frames: output,
                    name,
                }
            }
            RawKind::Layers { names } => Kind::Layers { names },
            RawKind::Namespace { name, prefix, uri } => {
                Kind::Namespace(namespace::Definition { name, prefix, uri })
            }
            RawKind::Property {
                inherits,
                initial_value,
                name,
                syntax,
            } => Kind::Property {
                inherits,
                initial_value: initial_value.map(Into::into),
                name,
                syntax,
            },
            RawKind::Rule { selector, style } => Kind::Rule {
                selector,
                style: self.style(style, false)?,
            },
        };

        Ok(contributions::Definition {
            kind,
            within: raw.within,
        })
    }
}

/// Reads a nonnegative integer index written as a JSON number.
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::float_cmp,
    reason = "A saturating cast that converts back exactly is a nonnegative integer index."
)]
fn index_of(value: f64) -> Option<usize> {
    let index = value as usize;

    (index as f64 == value).then_some(index)
}

fn lists(entries: Vec<(Arc<str>, Vec<Arc<str>>)>) -> token::Map<Arc<[Arc<str>]>> {
    entries
        .into_iter()
        .map(|(key, values)| (key, values.into()))
        .collect()
}

fn scalars(entries: Vec<(Arc<str>, RawScalar)>) -> Vec<(Arc<str>, Scalar)> {
    entries
        .into_iter()
        .map(|(key, value)| (key, value.into()))
        .collect()
}

/// Static target data decoded straight into evaluated values. Objects keep JSON document
/// order, which is JavaScript property order, and no hashed map is built.
struct JsonData(Data);

impl<'de> Deserialize<'de> for JsonData {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct DataVisitor;

        impl<'de> Visitor<'de> for DataVisitor {
            type Value = JsonData;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("static JSON data")
            }

            fn visit_unit<E: de::Error>(self) -> std::result::Result<Self::Value, E> {
                Ok(JsonData(Data::Null))
            }

            fn visit_bool<E: de::Error>(self, value: bool) -> std::result::Result<Self::Value, E> {
                Ok(JsonData(Data::Bool(value)))
            }

            #[expect(
                clippy::cast_precision_loss,
                reason = "JavaScript numbers are doubles."
            )]
            fn visit_u64<E: de::Error>(self, value: u64) -> std::result::Result<Self::Value, E> {
                Ok(JsonData(Data::Number(value as f64)))
            }

            #[expect(
                clippy::cast_precision_loss,
                reason = "JavaScript numbers are doubles."
            )]
            fn visit_i64<E: de::Error>(self, value: i64) -> std::result::Result<Self::Value, E> {
                Ok(JsonData(Data::Number(value as f64)))
            }

            fn visit_f64<E: de::Error>(self, value: f64) -> std::result::Result<Self::Value, E> {
                Ok(JsonData(Data::Number(value)))
            }

            fn visit_str<E: de::Error>(self, value: &str) -> std::result::Result<Self::Value, E> {
                Ok(JsonData(Data::from(value)))
            }

            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut items = Vec::new();

                while let Some(JsonData(item)) = seq.next_element()? {
                    items.push(item);
                }

                Ok(JsonData(Data::Array(Arc::new(items))))
            }

            fn visit_map<A: MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut object = Object::new();

                while let Some((key, JsonData(value))) = map.next_entry::<Arc<str>, JsonData>()? {
                    object.insert(key, value);
                }

                Ok(JsonData(Data::from(object)))
            }
        }

        deserializer.deserialize_any(DataVisitor)
    }
}

/// Top-level input fields other than the resolved tables.
#[derive(Default)]
struct RawInput<'a> {
    composition: Option<RawMode>,
    contributions: Vec<RawContribution<'a>>,
    css_output: Option<RawMode>,
    development: bool,
    labels: Option<Vec<RawLabel>>,
    names: Option<Vec<(Arc<str>, Arc<str>)>>,
    schemes: bool,
    scope: Option<Arc<str>>,
    shared: Option<Box<str>>,
    styles: Vec<Arc<NamedStyle>>,
    units: Option<RawUnits>,
    vars: Option<Vec<(Arc<str>, ThemeReference)>>,
}

/// Visits top-level keys in document order. The tables precede `styles`, so compiled styles
/// decode in place with every string and object already resolved.
struct InputSeed<'d> {
    decoder: &'d mut Decoder,
}

impl<'de> DeserializeSeed<'de> for InputSeed<'_> {
    type Value = RawInput<'de>;

    fn deserialize<D: Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> std::result::Result<Self::Value, D::Error> {
        deserializer.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for InputSeed<'_> {
    type Value = RawInput<'de>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("compiler input")
    }

    fn visit_map<A: MapAccess<'de>>(
        self,
        mut map: A,
    ) -> std::result::Result<Self::Value, A::Error> {
        let decoder = self.decoder;
        let mut raw = RawInput::default();
        let mut styled = false;

        while let Some(key) = map.next_key::<Text<'de>>()? {
            match &*key.0 {
                "composition" => raw.composition = map.next_value()?,
                "contributions" => raw.contributions = map.next_value()?,
                "cssOutput" => raw.css_output = map.next_value()?,
                "development" => raw.development = map.next_value()?,
                "labels" => raw.labels = map.next_value()?,
                "names" => raw.names = map.next_value()?,
                "objects" | "strings" if styled => {
                    return Err(de::Error::custom("objects and strings must precede styles"));
                }
                "objects" => {
                    for object in map.next_value::<Vec<RawObject<'de>>>()? {
                        let resolved = decoder
                            .object(object)
                            .map_err(|error| de::Error::custom(error.text()))?;

                        decoder.objects.push(resolved);
                    }
                }
                "schemes" => raw.schemes = map.next_value()?,
                "scope" => raw.scope = map.next_value()?,
                "shared" => raw.shared = map.next_value()?,
                "strings" => {
                    decoder.table = map
                        .next_value::<Vec<Text<'de>>>()?
                        .into_iter()
                        .map(|text| text.0.into())
                        .collect();
                }
                "styles" => {
                    let (styles, invalid) = map.next_value_seed(StylesSeed {
                        decoder: &mut *decoder,
                    })?;

                    styled = true;
                    raw.styles = styles;
                    decoder.invalid = invalid;
                }
                "units" => raw.units = map.next_value()?,
                "vars" => raw.vars = map.next_value()?,
                _ => {
                    map.next_value::<de::IgnoredAny>()?;
                }
            }
        }

        Ok(raw)
    }
}

/// A style name with its readable name and namespace.
type RawLabel = (Arc<str>, Option<Arc<str>>, Option<Arc<str>>);

#[derive(Deserialize)]
struct RawUnits {
    names: Vec<(Box<str>, Box<str>, Box<str>)>,
    owner: Arc<str>,
    qualifier: Arc<str>,
    visible: Option<Vec<Arc<str>>>,
}

/// A theme entry: a metadata index, `false` for a non-definition, or `null` for nullish values.
enum ThemeReference {
    Index(usize),
    Invalid,
    Nullish,
}

impl<'de> Deserialize<'de> for ThemeReference {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct ReferenceVisitor;

        impl Visitor<'_> for ReferenceVisitor {
            type Value = ThemeReference;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an object index, false, or null")
            }

            fn visit_u64<E: de::Error>(self, value: u64) -> std::result::Result<Self::Value, E> {
                usize::try_from(value)
                    .map(ThemeReference::Index)
                    .map_err(E::custom)
            }

            fn visit_bool<E: de::Error>(self, _: bool) -> std::result::Result<Self::Value, E> {
                Ok(ThemeReference::Invalid)
            }

            fn visit_unit<E: de::Error>(self) -> std::result::Result<Self::Value, E> {
                Ok(ThemeReference::Nullish)
            }
        }

        deserializer.deserialize_any(ReferenceVisitor)
    }
}

/// An own property's raw mode: a string, or a present non-string value.
enum RawMode {
    Invalid,
    Text(Box<str>),
}

impl RawMode {
    fn output(&self) -> Option<CssOutput> {
        match self {
            Self::Text(text) => CssOutput::parse(text),
            Self::Invalid => None,
        }
    }

    /// Only `independent` isolates; every other present mode orders.
    fn composition(&self) -> Composition {
        match self {
            Self::Text(text) if &**text == "independent" => Composition::Independent,
            _ => Composition::Ordered,
        }
    }
}

impl<'de> Deserialize<'de> for RawMode {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct ModeVisitor;

        impl Visitor<'_> for ModeVisitor {
            type Value = RawMode;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a mode string or false")
            }

            fn visit_str<E: de::Error>(self, value: &str) -> std::result::Result<Self::Value, E> {
                Ok(RawMode::Text(value.into()))
            }

            fn visit_bool<E: de::Error>(self, _: bool) -> std::result::Result<Self::Value, E> {
                Ok(RawMode::Invalid)
            }
        }

        deserializer.deserialize_any(ModeVisitor)
    }
}

struct RawContractFields {
    complete: bool,
    composition: Option<Box<str>>,
    css_output: Option<Box<str>>,
    default_layer: Option<Arc<str>>,
    identity: Option<Arc<str>>,
    keys: Vec<Box<str>>,
    mappings: Option<RawMappings>,
    shorthands: Option<Entries>,
    variable_set: bool,
}

/// String-list records keep JSON document order, which is JavaScript property order.
type Entries = Vec<(Arc<str>, Vec<Arc<str>>)>;

enum RawMappings {
    Categories(Entries),
    Disabled,
}

/// Deserializes a JSON object of string lists into ordered entries.
struct EntriesVisitor;

impl<'de> Visitor<'de> for EntriesVisitor {
    type Value = Entries;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("an object of string lists")
    }

    fn visit_map<A: MapAccess<'de>>(
        self,
        mut map: A,
    ) -> std::result::Result<Self::Value, A::Error> {
        let mut entries = Vec::with_capacity(map.size_hint().unwrap_or_default());

        while let Some((key, values)) = map.next_entry::<Arc<str>, Vec<Arc<str>>>()? {
            entries.push((key, values));
        }

        Ok(entries)
    }
}

impl<'de> Deserialize<'de> for RawMappings {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct MappingsVisitor;

        impl<'de> Visitor<'de> for MappingsVisitor {
            type Value = RawMappings;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("false or an object of property lists")
            }

            fn visit_bool<E: de::Error>(self, _: bool) -> std::result::Result<Self::Value, E> {
                Ok(RawMappings::Disabled)
            }

            fn visit_map<A: MapAccess<'de>>(
                self,
                map: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                EntriesVisitor.visit_map(map).map(RawMappings::Categories)
            }
        }

        deserializer.deserialize_any(MappingsVisitor)
    }
}

#[derive(Default)]
struct RawQueries {
    breakpoint: Vec<(String, String)>,
    container: Vec<(String, String)>,
    container_names: Vec<String>,
}

impl<'de> Deserialize<'de> for RawQueries {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct PairsVisitor;

        impl<'de> Visitor<'de> for PairsVisitor {
            type Value = Vec<(String, String)>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an object of strings")
            }

            fn visit_map<A: MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut entries = Vec::new();

                while let Some(entry) = map.next_entry::<String, String>()? {
                    entries.push(entry);
                }

                Ok(entries)
            }
        }

        struct Pairs(Vec<(String, String)>);

        impl<'de> Deserialize<'de> for Pairs {
            fn deserialize<D: Deserializer<'de>>(
                deserializer: D,
            ) -> std::result::Result<Self, D::Error> {
                deserializer.deserialize_map(PairsVisitor).map(Pairs)
            }
        }

        struct QueriesVisitor;

        impl<'de> Visitor<'de> for QueriesVisitor {
            type Value = RawQueries;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("query metadata")
            }

            fn visit_map<A: MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut queries = RawQueries::default();

                while let Some(key) = map.next_key::<Box<str>>()? {
                    match &*key {
                        "breakpoint" => queries.breakpoint = map.next_value::<Pairs>()?.0,
                        "container" => queries.container = map.next_value::<Pairs>()?.0,
                        "containerNames" => queries.container_names = map.next_value()?,
                        _ => {
                            map.next_value::<de::IgnoredAny>()?;
                        }
                    }
                }

                Ok(queries)
            }
        }

        deserializer.deserialize_map(QueriesVisitor)
    }
}

struct EntriesField(Entries);

impl<'de> Deserialize<'de> for EntriesField {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        deserializer
            .deserialize_map(EntriesVisitor)
            .map(EntriesField)
    }
}

enum RawObject<'a> {
    Binding(Arc<str>, Box<str>, bool),
    Contract(Box<RawContractFields>),
    Expression(Option<Arc<str>>, Vec<RawPart>),
    Theme(
        usize,
        Option<Arc<str>>,
        Vec<(Arc<str>, RawValue<'a>)>,
        Option<Entries>,
        Option<RawQueries>,
    ),
    Token(usize, Arc<str>, Arc<str>, RawValue<'a>, bool),
}

impl<'de: 'a, 'a> Deserialize<'de> for RawObject<'a> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct ObjectVisitor<'a>(PhantomData<&'a ()>);

        fn next<'de, T: Deserialize<'de>, A: SeqAccess<'de>>(
            seq: &mut A,
        ) -> std::result::Result<T, A::Error> {
            seq.next_element()?
                .ok_or_else(|| de::Error::custom("truncated object entry"))
        }

        impl<'de: 'a, 'a> Visitor<'de> for ObjectVisitor<'a> {
            type Value = RawObject<'a>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a tagged object entry")
            }

            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let tag: Box<str> = next(&mut seq)?;

                Ok(match &*tag {
                    "b" => RawObject::Binding(next(&mut seq)?, next(&mut seq)?, next(&mut seq)?),
                    "c" => RawObject::Contract(Box::new(next(&mut seq)?)),
                    "e" => RawObject::Expression(next(&mut seq)?, next(&mut seq)?),
                    "m" => {
                        let contract = next(&mut seq)?;
                        let css_name = next(&mut seq)?;
                        let values = next(&mut seq)?;
                        let paths: Option<EntriesField> = next(&mut seq)?;
                        let queries = next(&mut seq)?;

                        RawObject::Theme(
                            contract,
                            css_name,
                            values,
                            paths.map(|paths| paths.0),
                            queries,
                        )
                    }
                    "t" => RawObject::Token(
                        next(&mut seq)?,
                        next(&mut seq)?,
                        next(&mut seq)?,
                        next(&mut seq)?,
                        next(&mut seq)?,
                    ),
                    other => {
                        return Err(de::Error::custom(format_args!(
                            "unknown object tag {other}"
                        )));
                    }
                })
            }
        }

        deserializer.deserialize_seq(ObjectVisitor(PhantomData))
    }
}

impl<'de> Deserialize<'de> for RawContractFields {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct ContractVisitor;

        impl<'de> Visitor<'de> for ContractVisitor {
            type Value = RawContractFields;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("contract fields")
            }

            fn visit_map<A: MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut fields = RawContractFields {
                    complete: false,
                    composition: None,
                    css_output: None,
                    default_layer: None,
                    identity: None,
                    keys: Vec::new(),
                    mappings: None,
                    shorthands: None,
                    variable_set: false,
                };

                while let Some(key) = map.next_key::<Box<str>>()? {
                    match &*key {
                        "complete" => fields.complete = map.next_value()?,
                        "composition" => fields.composition = map.next_value()?,
                        "cssOutput" => fields.css_output = map.next_value()?,
                        "defaultLayer" => fields.default_layer = map.next_value()?,
                        "identity" => fields.identity = map.next_value()?,
                        "keys" => fields.keys = map.next_value()?,
                        "mappings" => fields.mappings = map.next_value()?,
                        "shorthands" => {
                            fields.shorthands = map
                                .next_value::<Option<EntriesField>>()?
                                .map(|field| field.0);
                        }
                        "variableSet" => fields.variable_set = map.next_value()?,
                        _ => {
                            map.next_value::<de::IgnoredAny>()?;
                        }
                    }
                }

                Ok(fields)
            }
        }

        deserializer.deserialize_map(ContractVisitor)
    }
}

enum RawPart {
    Reference(usize),
    Text(Arc<str>),
}

impl<'de> Deserialize<'de> for RawPart {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct PartVisitor;

        impl<'de> Visitor<'de> for PartVisitor {
            type Value = RawPart;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("text or a reference")
            }

            fn visit_str<E: de::Error>(self, value: &str) -> std::result::Result<Self::Value, E> {
                Ok(RawPart::Text(value.into()))
            }

            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let index: usize = seq
                    .next_element()?
                    .ok_or_else(|| de::Error::custom("empty reference"))?;

                Ok(RawPart::Reference(index))
            }
        }

        deserializer.deserialize_any(PartVisitor)
    }
}

enum RawValue<'a> {
    Number(f64),
    Record(Vec<(Arc<str>, RawValue<'a>)>),
    Reference(usize),
    String(Text<'a>),
}

impl<'de: 'a, 'a> Deserialize<'de> for RawValue<'a> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct ValueVisitor<'a>(PhantomData<&'a ()>);

        impl<'de: 'a, 'a> Visitor<'de> for ValueVisitor<'a> {
            type Value = RawValue<'a>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a declaration or token value")
            }

            fn visit_borrowed_str<E: de::Error>(
                self,
                value: &'de str,
            ) -> std::result::Result<Self::Value, E> {
                Ok(RawValue::String(Text(Cow::Borrowed(value))))
            }

            fn visit_str<E: de::Error>(self, value: &str) -> std::result::Result<Self::Value, E> {
                Ok(RawValue::String(Text(Cow::Owned(value.to_owned()))))
            }

            #[expect(
                clippy::cast_precision_loss,
                reason = "JavaScript numbers are doubles."
            )]
            fn visit_u64<E: de::Error>(self, value: u64) -> std::result::Result<Self::Value, E> {
                Ok(RawValue::Number(value as f64))
            }

            #[expect(
                clippy::cast_precision_loss,
                reason = "JavaScript numbers are doubles."
            )]
            fn visit_i64<E: de::Error>(self, value: i64) -> std::result::Result<Self::Value, E> {
                Ok(RawValue::Number(value as f64))
            }

            fn visit_f64<E: de::Error>(self, value: f64) -> std::result::Result<Self::Value, E> {
                Ok(RawValue::Number(value))
            }

            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let index: usize = seq
                    .next_element()?
                    .ok_or_else(|| de::Error::custom("empty reference"))?;

                Ok(RawValue::Reference(index))
            }

            fn visit_map<A: MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let key: Box<str> = map
                    .next_key()?
                    .ok_or_else(|| de::Error::custom("empty tagged value"))?;

                match &*key {
                    "n" => {
                        let text: Box<str> = map.next_value()?;

                        Ok(RawValue::Number(match &*text {
                            "Infinity" => f64::INFINITY,
                            "-Infinity" => f64::NEG_INFINITY,
                            _ => f64::NAN,
                        }))
                    }
                    "r" => Ok(RawValue::Record(map.next_value()?)),
                    other => Err(de::Error::custom(format_args!("unknown value tag {other}"))),
                }
            }
        }

        deserializer.deserialize_any(ValueVisitor(PhantomData))
    }
}

/// The first invalid output mode in a style subtree, in `Css.compile` validation order.
type Invalid = Option<Vec<Arc<str>>>;

/// Decodes the compiled style list, reporting its first invalid output mode.
struct StylesSeed<'d> {
    decoder: &'d mut Decoder,
}

impl<'de> DeserializeSeed<'de> for StylesSeed<'_> {
    type Value = (Vec<Arc<NamedStyle>>, Invalid);

    fn deserialize<D: Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> std::result::Result<Self::Value, D::Error> {
        deserializer.deserialize_seq(self)
    }
}

impl<'de> Visitor<'de> for StylesSeed<'_> {
    type Value = (Vec<Arc<NamedStyle>>, Invalid);

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a style list")
    }

    fn visit_seq<A: SeqAccess<'de>>(
        self,
        mut seq: A,
    ) -> std::result::Result<Self::Value, A::Error> {
        let decoder = self.decoder;
        let mut styles = Vec::with_capacity(seq.size_hint().unwrap_or(64));
        let mut invalid = None;

        while let Some((style, found)) = seq.next_element_seed(StyleSeed {
            decoder: &mut *decoder,
        })? {
            invalid = invalid.or(found);
            styles.push(style);
        }

        Ok((styles, invalid))
    }
}

/// Decodes one compiled style directly into its definition.
struct StyleSeed<'d> {
    decoder: &'d mut Decoder,
}

impl<'de> DeserializeSeed<'de> for StyleSeed<'_> {
    type Value = (Arc<NamedStyle>, Invalid);

    fn deserialize<D: Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> std::result::Result<Self::Value, D::Error> {
        deserializer.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for StyleSeed<'_> {
    type Value = (Arc<NamedStyle>, Invalid);

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a style")
    }

    fn visit_map<A: MapAccess<'de>>(
        self,
        mut map: A,
    ) -> std::result::Result<Self::Value, A::Error> {
        let decoder = self.decoder;
        let mut composition = None;
        let mut css_output = None;
        let mut declarations = Vec::new();
        let mut name: Option<Arc<str>> = None;
        let mut rules = None;
        let mut rules_invalid = None;
        let mut targets = None;
        let mut web_invalid = None;

        while let Some(key) = map.next_key::<Text<'de>>()? {
            match &*key.0 {
                "c" => composition = Some(map.next_value::<RawMode>()?.composition()),
                "d" => {
                    declarations = map.next_value_seed(DeclarationsSeed {
                        decoder: &mut *decoder,
                    })?;
                }
                "n" => name = Some(map.next_value()?),
                "o" => css_output = Some(map.next_value::<RawMode>()?),
                "r" => {
                    let (list, found) = map.next_value_seed(RulesSeed {
                        decoder: &mut *decoder,
                    })?;

                    rules = Some(list);
                    rules_invalid = found;
                }
                "t" => {
                    let (branches, found) = map.next_value_seed(TargetsSeed {
                        decoder: &mut *decoder,
                    })?;

                    targets = Some(branches);
                    web_invalid = found;
                }
                _ => {
                    map.next_value::<de::IgnoredAny>()?;
                }
            }
        }

        let name = name.ok_or_else(|| de::Error::missing_field("n"))?;
        let output = css_output.as_ref().and_then(RawMode::output);
        let own = (css_output.is_some() && output.is_none())
            .then(|| vec![Arc::clone(&name), Arc::from("cssOutput")]);

        Ok((
            Arc::new(NamedStyle {
                composition,
                css_output: output,
                declarations,
                name,
                rules,
                targets,
            }),
            own.or(rules_invalid).or(web_invalid),
        ))
    }
}

/// Decodes flat declaration triples.
struct DeclarationsSeed<'d> {
    decoder: &'d mut Decoder,
}

impl<'de> DeserializeSeed<'de> for DeclarationsSeed<'_> {
    type Value = Vec<Declaration>;

    fn deserialize<D: Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> std::result::Result<Self::Value, D::Error> {
        deserializer.deserialize_seq(self)
    }
}

impl<'de> Visitor<'de> for DeclarationsSeed<'_> {
    type Value = Vec<Declaration>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("declaration triples")
    }

    fn visit_seq<A: SeqAccess<'de>>(
        self,
        mut seq: A,
    ) -> std::result::Result<Self::Value, A::Error> {
        let mut declarations = Vec::with_capacity(seq.size_hint().map_or(8, |hint| hint / 3));

        while let Some(property) = seq.next_element::<f64>()? {
            let (Some(value), Some(flags)) =
                (seq.next_element::<f64>()?, seq.next_element::<f64>()?)
            else {
                return Err(de::Error::custom("declarations must be triples"));
            };

            declarations.push(
                self.decoder
                    .declaration(property, value, flags)
                    .map_err(|error| de::Error::custom(error.text()))?,
            );
        }

        Ok(declarations)
    }
}

/// Decodes `[condition, style]` rule pairs.
struct RulesSeed<'d> {
    decoder: &'d mut Decoder,
}

impl<'de> DeserializeSeed<'de> for RulesSeed<'_> {
    type Value = (Vec<Rule>, Invalid);

    fn deserialize<D: Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> std::result::Result<Self::Value, D::Error> {
        deserializer.deserialize_seq(self)
    }
}

impl<'de> Visitor<'de> for RulesSeed<'_> {
    type Value = (Vec<Rule>, Invalid);

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("rule pairs")
    }

    fn visit_seq<A: SeqAccess<'de>>(
        self,
        mut seq: A,
    ) -> std::result::Result<Self::Value, A::Error> {
        let decoder = self.decoder;
        let mut rules = Vec::new();
        let mut invalid = None;

        while let Some((rule, found)) = seq.next_element_seed(RuleSeed {
            decoder: &mut *decoder,
        })? {
            invalid = invalid.or(found);
            rules.push(rule);
        }

        Ok((rules, invalid))
    }
}

struct RuleSeed<'d> {
    decoder: &'d mut Decoder,
}

impl<'de> DeserializeSeed<'de> for RuleSeed<'_> {
    type Value = (Rule, Invalid);

    fn deserialize<D: Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> std::result::Result<Self::Value, D::Error> {
        deserializer.deserialize_seq(self)
    }
}

impl<'de> Visitor<'de> for RuleSeed<'_> {
    type Value = (Rule, Invalid);

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a condition and a style")
    }

    fn visit_seq<A: SeqAccess<'de>>(
        self,
        mut seq: A,
    ) -> std::result::Result<Self::Value, A::Error> {
        let decoder = self.decoder;
        let condition: Option<Text<'de>> = seq
            .next_element()?
            .ok_or_else(|| de::Error::custom("rules must be pairs"))?;
        let condition = condition.map(|condition| decoder.intern(condition));
        let (style, invalid) = seq
            .next_element_seed(StyleSeed {
                decoder: &mut *decoder,
            })?
            .ok_or_else(|| de::Error::custom("rules must be pairs"))?;

        Ok((Rule { condition, style }, invalid))
    }
}

/// Decodes target branches: static native data and a web style.
struct TargetsSeed<'d> {
    decoder: &'d mut Decoder,
}

impl<'de> DeserializeSeed<'de> for TargetsSeed<'_> {
    type Value = (Targets, Invalid);

    fn deserialize<D: Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> std::result::Result<Self::Value, D::Error> {
        deserializer.deserialize_map(self)
    }
}

impl<'de> Visitor<'de> for TargetsSeed<'_> {
    type Value = (Targets, Invalid);

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("target branches")
    }

    fn visit_map<A: MapAccess<'de>>(
        self,
        mut map: A,
    ) -> std::result::Result<Self::Value, A::Error> {
        let decoder = self.decoder;
        let mut targets = Targets::default();
        let mut invalid = None;

        while let Some(key) = map.next_key::<Text<'de>>()? {
            match &*key.0 {
                "android" => targets.android = Some(map.next_value::<JsonData>()?.0),
                "ios" => targets.ios = Some(map.next_value::<JsonData>()?.0),
                "native" => targets.native = Some(map.next_value::<JsonData>()?.0),
                "web" => {
                    let (web, found) = map.next_value_seed(StyleSeed {
                        decoder: &mut *decoder,
                    })?;

                    targets.web = Some(web);
                    invalid = found;
                }
                _ => {
                    map.next_value::<de::IgnoredAny>()?;
                }
            }
        }

        Ok((targets, invalid))
    }
}

/// A string borrowed from the wire input when it needs no unescaping.
struct Text<'a>(Cow<'a, str>);

impl<'de: 'a, 'a> Deserialize<'de> for Text<'a> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct TextVisitor<'a>(PhantomData<&'a ()>);

        impl<'de: 'a, 'a> Visitor<'de> for TextVisitor<'a> {
            type Value = Text<'a>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a string")
            }

            fn visit_borrowed_str<E: de::Error>(
                self,
                value: &'de str,
            ) -> std::result::Result<Self::Value, E> {
                Ok(Text(Cow::Borrowed(value)))
            }

            fn visit_str<E: de::Error>(self, value: &str) -> std::result::Result<Self::Value, E> {
                Ok(Text(Cow::Owned(value.to_owned())))
            }

            fn visit_string<E: de::Error>(
                self,
                value: String,
            ) -> std::result::Result<Self::Value, E> {
                Ok(Text(Cow::Owned(value)))
            }
        }

        deserializer.deserialize_str(TextVisitor(PhantomData))
    }
}

#[derive(Deserialize)]
struct RawStyle<'a> {
    #[serde(default, rename = "c")]
    composition: Option<RawMode>,
    #[serde(default, rename = "o")]
    css_output: Option<RawMode>,
    #[serde(default, rename = "d")]
    declarations: Vec<f64>,
    #[serde(rename = "n")]
    name: Arc<str>,
    #[serde(borrow, default, rename = "r")]
    rules: Option<Vec<(Option<Text<'a>>, RawStyle<'a>)>>,
    #[serde(borrow, default, rename = "t")]
    targets: Option<RawTargets<'a>>,
}

#[derive(Deserialize)]
struct RawTargets<'a> {
    #[serde(default)]
    android: Option<JsonData>,
    #[serde(default)]
    ios: Option<JsonData>,
    #[serde(default)]
    native: Option<JsonData>,
    #[serde(borrow, default)]
    web: Option<Box<RawStyle<'a>>>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RawScalar {
    Number(f64),
    String(Arc<str>),
}

impl From<RawScalar> for Scalar {
    fn from(value: RawScalar) -> Self {
        match value {
            RawScalar::Number(number) => Self::Number(number),
            RawScalar::String(text) => Self::String(text),
        }
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RawLayer {
    Anonymous(bool),
    Named(Arc<str>),
}

#[derive(Deserialize)]
#[serde(tag = "kind")]
enum RawEntry<'a> {
    #[serde(rename = "block")]
    Block {
        #[serde(borrow)]
        entries: Vec<RawEntry<'a>>,
        header: Arc<str>,
    },
    #[serde(rename = "descriptor")]
    Descriptor { name: Arc<str>, value: RawScalar },
    #[serde(rename = "style")]
    Style {
        #[serde(borrow)]
        style: Box<RawStyle<'a>>,
    },
}

#[derive(Deserialize)]
struct RawContribution<'a> {
    #[serde(borrow, flatten)]
    kind: RawKind<'a>,
    #[serde(default)]
    within: Vec<Arc<str>>,
}

#[derive(Deserialize)]
#[serde(tag = "kind")]
enum RawKind<'a> {
    #[serde(rename = "block")]
    Block {
        #[serde(borrow)]
        entries: Vec<RawEntry<'a>>,
        header: Arc<str>,
    },
    #[serde(rename = "custom-media")]
    CustomMedia { name: Arc<str>, query: Arc<str> },
    #[serde(rename = "descriptor")]
    Descriptor {
        declarations: Vec<(Arc<str>, RawScalar)>,
        name: Arc<str>,
        rule: Arc<str>,
    },
    #[serde(rename = "font-face")]
    FontFace {
        declarations: Vec<(Arc<str>, RawScalar)>,
    },
    #[serde(rename = "import")]
    Import {
        #[serde(default)]
        layer: Option<RawLayer>,
        #[serde(default)]
        media: Option<Arc<str>>,
        #[serde(default)]
        supports: Option<Arc<str>>,
        url: Arc<str>,
    },
    #[serde(rename = "keyframes")]
    Keyframes {
        #[serde(borrow)]
        frames: Vec<(Arc<str>, RawStyle<'a>)>,
        name: Arc<str>,
    },
    #[serde(rename = "layers")]
    Layers { names: Vec<Arc<str>> },
    #[serde(rename = "namespace")]
    Namespace {
        name: Arc<str>,
        #[serde(default)]
        prefix: Option<Arc<str>>,
        uri: Arc<str>,
    },
    #[serde(rename = "property")]
    Property {
        inherits: bool,
        #[serde(default, rename = "initialValue")]
        initial_value: Option<RawScalar>,
        name: Arc<str>,
        syntax: Arc<str>,
    },
    #[serde(rename = "rule")]
    Rule {
        selector: Arc<str>,
        #[serde(borrow)]
        style: RawStyle<'a>,
    },
}

/// Encodes a compilation result or failure.
pub fn encode(result: &Result<Output>) -> String {
    match result {
        Ok(output) => encode_output(output),
        Err(error) => encode_error(error),
    }
}

/// Writes a record in JavaScript property order: array-index keys ascending, then insertion order.
fn write_record<'a>(output: &mut String, entries: impl Iterator<Item = (&'a str, &'a str)>) {
    let mut entries: Vec<(&str, &str)> = entries.collect();

    if entries
        .iter()
        .any(|(key, _)| js::array_index(key).is_some())
    {
        // A stable sort keeps insertion order among non-index keys.
        entries.sort_by_key(|(key, _)| js::array_index(key).map_or(u64::MAX, u64::from));
    }

    output.push('{');

    for (index, (key, value)) in entries.into_iter().enumerate() {
        if index > 0 {
            output.push(',');
        }

        js::write_string(output, key);
        output.push(':');
        js::write_string(output, value);
    }

    output.push('}');
}

fn write_strings<'a>(output: &mut String, values: impl Iterator<Item = &'a str>) {
    output.push('[');

    for (index, value) in values.enumerate() {
        if index > 0 {
            output.push(',');
        }

        js::write_string(output, value);
    }

    output.push(']');
}

fn write_resource(output: &mut String, resource: &Resource) {
    output.push_str("{\"css\":");
    js::write_string(output, &resource.css);
    output.push_str(",\"id\":");
    js::write_string(output, &resource.id);

    if let Some(rules) = &resource.rules {
        output.push_str(",\"rules\":[");

        for (index, rule) in rules.iter().enumerate() {
            if index > 0 {
                output.push(',');
            }

            output.push_str("{\"conditions\":");
            write_strings(output, rule.conditions.iter().map(|condition| &**condition));
            output.push_str(",\"property\":");
            js::write_string(output, &rule.property);
            output.push_str(",\"selector\":");
            js::write_string(output, &rule.selector);
            output.push_str(",\"value\":");
            js::write_string(output, &rule.value);
            output.push('}');
        }

        output.push(']');
    }

    output.push('}');
}

fn encode_output(result: &Output) -> String {
    let mut output = String::with_capacity(
        result.css.len() * 2 + result.classes.len() * 32 + result.rules.len() * 64,
    );

    output.push_str("{\"classes\":");
    write_record(
        &mut output,
        result
            .classes
            .iter()
            .map(|(name, class)| (&**name, class.as_str())),
    );
    output.push_str(",\"css\":");
    js::write_string(&mut output, &result.css);
    output.push_str(",\"vars\":");
    write_record(
        &mut output,
        result
            .vars
            .iter()
            .map(|(name, class)| (&**name, class.as_str())),
    );

    if let Some(css) = &result.contribution_css {
        output.push_str(",\"contributionCss\":");
        js::write_string(&mut output, css);
    }

    if let Some(css) = &result.scoped_css {
        output.push_str(",\"scopedCss\":");
        js::write_string(&mut output, css);
    }

    output.push_str(",\"rules\":");
    write_record(
        &mut output,
        result
            .rules
            .iter()
            .map(|(name, body)| (name.as_str(), body.as_str())),
    );
    output.push_str(",\"units\":[");

    for (index, (key, decision)) in result.units.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }

        output.push('[');
        js::write_string(&mut output, key);
        output.push_str(if decision.borrowed {
            ",true,"
        } else {
            ",false,"
        });
        js::write_string(&mut output, &decision.name);
        output.push(']');
    }

    output.push(']');

    if let Some(resources) = &result.shared {
        output.push_str(",\"shared\":[");

        for (index, resource) in resources.iter().enumerate() {
            if index > 0 {
                output.push(',');
            }

            write_resource(&mut output, resource);
        }

        output.push(']');
    }

    output.push('}');
    output
}

fn encode_error(error: &Error) -> String {
    let mut output = String::from("{\"error\":{\"name\":");

    match error {
        Error::Css(diagnostics) => {
            js::write_string(&mut output, "Css.CompileError");
            output.push_str(",\"message\":");
            js::write_string(&mut output, &error.text());
            output.push_str(",\"diagnostics\":[");

            for (index, diagnostic) in diagnostics.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }

                output.push_str("{\"code\":");
                js::write_string(&mut output, diagnostic.code.as_str());
                output.push_str(",\"message\":");
                js::write_string(&mut output, &diagnostic.message);
                output.push_str(",\"path\":");
                write_strings(&mut output, diagnostic.path.iter().map(|part| &**part));
                output.push('}');
            }

            output.push(']');
        }
        other => {
            js::write_string(&mut output, "Error");
            output.push_str(",\"message\":");
            js::write_string(&mut output, &other.text());
        }
    }

    output.push_str("}}");
    output
}
