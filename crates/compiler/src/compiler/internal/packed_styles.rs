//! Packed style definitions that library contracts carry for consumers.

use std::sync::Arc;

use rustc_hash::FxHashMap;

use crate::compiler::internal::dynamic::Slots;
use crate::compiler::internal::recipes;
use crate::compiler::internal::themes::Output;
use crate::compiler::source::{Call, NativeContext};
use crate::data::{Data, Object};
use crate::error::{Error, Result};
use crate::generated::literal;
use crate::internal::binding::{self, Domain};
use crate::internal::token::{self, Composition, CssOutput};
use crate::internal::{condition, recipe, theme};
use crate::js::{self, Record};
use crate::runtime::recipe as runtime;
use crate::style::{Declaration, NamedStyle, Rule, Targets, Value};

/// Dynamic recipe data of a packed style.
#[derive(Clone, Debug, PartialEq)]
pub struct Dynamic {
    /// Default payload values by axis and field.
    pub default_payloads: Option<crate::js::Record<crate::js::Record<runtime::Scalar>>>,
    /// Payload slot bindings.
    pub payloads: Option<Vec<runtime::Payload>>,
    /// Ordered dynamic alternatives.
    pub recipe: recipe::Definition,
    /// Typed runtime slots.
    pub slots: Slots,
}

/// A style as a packed library exports it.
#[derive(Clone, Debug, PartialEq)]
pub struct Definition {
    /// Recipe attributes.
    pub attributes: Vec<Arc<str>>,
    /// Compiled class name.
    pub class_name: Option<Arc<str>>,
    /// Dynamic alternatives and slots.
    pub dynamic: Option<Dynamic>,
    /// Native alternatives of the authoring contract.
    pub native_context: Option<NativeContext>,
    /// `html` when the style emits HTML attributes.
    pub output: Option<Output>,
    /// Whether the definition was read from a contract, which lists `className` after
    /// `attributes` rather than last.
    pub packed: bool,
    /// Variable slots.
    pub slots: Vec<Arc<str>>,
    /// Static recipe alternatives.
    pub static_recipe: Option<recipe::Definition>,
    /// The style.
    pub style: Arc<NamedStyle>,
}

fn single(style: &Arc<NamedStyle>) -> recipe::Definition {
    recipe::Definition {
        axes: Vec::new(),
        defaults: Vec::new(),
        rules: vec![recipe::Rule {
            matches: Vec::new(),
            value: crate::style::Definition {
                labels: None,
                styles: vec![Arc::clone(style)],
            },
        }],
    }
}

/// Captures a style's ownership without retaining source ASTs or executable expressions.
pub fn create(call: &Call<'_>, style: Arc<NamedStyle>) -> Definition {
    let dynamic = (call.slots.is_some() || call.dynamic_recipe.is_some()).then(|| Dynamic {
        default_payloads: call
            .recipe
            .as_ref()
            .and_then(|recipe| recipe.default_payloads.clone()),
        payloads: call
            .recipe
            .as_ref()
            .and_then(|recipe| recipe.payloads.clone()),
        recipe: call
            .dynamic_recipe
            .clone()
            .unwrap_or_else(|| single(&style)),
        slots: call.slots.clone().unwrap_or_default(),
    });
    let attributes = call.recipe.as_ref().map_or_else(Vec::new, |recipe| {
        let conditions = recipe.conditions.as_ref().map_or(0, Vec::len);

        recipe
            .axes
            .keys()
            .flat_map(|axis| {
                std::iter::once(Arc::from(format!("data-{axis}"))).chain(
                    (0..conditions).map(|condition| Arc::from(recipes::attribute(axis, condition))),
                )
            })
            .collect()
    });
    let slots = call
        .slots
        .iter()
        .flat_map(|slots| slots.values().map(|slot| Arc::from(slot.name.as_str())))
        .chain(call.recipe.iter().flat_map(|recipe| {
            recipe.payloads.iter().flatten().flat_map(|payload| {
                payload
                    .slots
                    .iter()
                    .flat_map(|slots| slots.values().cloned())
            })
        }))
        .collect();
    let html = matches!(call.output, Some(Output::Html));
    let static_recipe = call.static_recipe.clone().or_else(|| {
        (call.slots.is_none() && call.recipe.is_none() && !html).then(|| single(&style))
    });

    Definition {
        attributes,
        class_name: None,
        dynamic,
        native_context: call.native_context.clone(),
        output: call.output,
        packed: false,
        slots,
        static_recipe,
        style,
    }
}

fn invalid(message: &str) -> Error {
    Error::Message(message.to_owned())
}

fn array(value: &Data) -> Result<&[Data]> {
    match value {
        Data::Array(items) => Ok(items),
        _ => Err(invalid("Expected a packed style array.")),
    }
}

fn object(value: &Data) -> Result<&Object> {
    match value {
        Data::Object(object) => Ok(object),
        _ => Err(invalid("Expected a packed style object.")),
    }
}

fn string(value: &Data) -> Result<Arc<str>> {
    match value {
        Data::String(text) => Ok(Arc::clone(text)),
        _ => Err(invalid("Expected a packed style string.")),
    }
}

fn get<'d>(object: &'d Object, key: &str) -> &'d Data {
    object.get(key).unwrap_or(&Data::Undefined)
}

/// Matches `^(?:--z-|data-)[a-zA-Z0-9_-]+$` after the given prefix.
fn named(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|rest| {
        !rest.is_empty()
            && rest
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    })
}

/// Appends a token value as `JSON.stringify` writes it with the packed-style replacer.
fn encode_value(output: &mut String, value: &token::Value) {
    match value {
        token::Value::Composition(expression) => encode_expression(output, expression),
        token::Value::Number(number) if number.is_finite() => js::write_number(output, *number),
        token::Value::Number(_) => output.push_str("null"),
        token::Value::Record(entries) => {
            js::write_object(
                output,
                entries.iter().map(|(key, value)| (&**key, value)),
                encode_value,
            );
        }
        token::Value::Reference(reference) => encode_reference(output, reference),
        token::Value::String(text) => js::write_string(output, text),
    }
}

fn encode_reference(output: &mut String, reference: &token::Reference) {
    output.push('{');

    if let Some(identity) = &reference.contract.identity {
        output.push_str("\"identity\":");
        js::write_string(output, identity);
        output.push(',');
    }

    output.push_str("\"kind\":\"token\",\"path\":");
    js::write_string(output, &reference.path);
    output.push_str(",\"value\":");
    encode_value(output, &reference.value);
    output.push('}');
}

fn encode_expression(output: &mut String, expression: &token::Expression) {
    output.push_str("{\"kind\":\"expression\",\"parts\":[");

    for (index, part) in expression.parts.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }

        match part {
            token::Part::Text(text) => js::write_string(output, text),
            token::Part::Reference(reference) => encode_reference(output, reference),
            token::Part::Binding(binding) => encode_binding(output, binding),
        }
    }

    output.push_str("]}");
}

/// Appends a binding reference as `JSON.stringify` writes it.
pub(crate) fn encode_binding(output: &mut String, binding: &binding::Reference) {
    output.push_str("{\"name\":");
    js::write_string(output, &binding.name);
    output.push_str(",\"type\":");
    js::write_string(output, binding.domain.as_str());

    if binding.zero {
        output.push_str(",\"zero\":true");
    }

    output.push_str(",\"variable\":true}");
}

/// The lookup key `JSON.stringify([identity, path, ...value])`.
fn token_key(identity: Option<&str>, path: &str, value: Option<&dyn Fn(&mut String)>) -> String {
    let mut key = String::from("[");

    match identity {
        Some(identity) => js::write_string(&mut key, identity),
        None => key.push_str("null"),
    }

    key.push(',');
    js::write_string(&mut key, path);

    if let Some(value) = value {
        key.push(',');
        value(&mut key);
    }

    key.push(']');
    key
}

fn collect(value: &Data, tokens: &mut FxHashMap<String, Arc<token::Reference>>) {
    match value {
        Data::Token(reference) => {
            let identity = reference.contract.identity.as_deref();

            tokens.insert(
                token_key(identity, &reference.path, None),
                Arc::clone(reference),
            );
            // Catalog themes share identities and paths but keep distinct fallback values.
            tokens.insert(
                token_key(
                    identity,
                    &reference.path,
                    Some(&|output: &mut String| encode_value(output, &reference.value)),
                ),
                Arc::clone(reference),
            );
        }
        Data::Object(object) => {
            for (_, child) in object.iter() {
                collect(child, tokens);
            }
        }
        Data::Array(items) => {
            for child in items.iter() {
                collect(child, tokens);
            }
        }
        _ => {}
    }
}

struct Reader<'t> {
    tokens: &'t FxHashMap<String, Arc<token::Reference>>,
    version: u32,
}

impl Reader<'_> {
    fn scalar(&self, value: &Data, depth: usize) -> Result<Value> {
        if depth > 64 {
            return Err(invalid("Packed style expression exceeds 64 levels."));
        }

        match value {
            Data::String(text) => return Ok(Value::String(Arc::clone(text))),
            Data::Number(number) if number.is_finite() => return Ok(Value::Number(*number)),
            _ => {}
        }

        let item = object(value)?;

        match get(item, "kind").as_str() {
            Some("token") => {
                let identity = match get(item, "identity") {
                    Data::String(identity) => Some(&**identity),
                    _ => None,
                };
                let path = get(item, "path");
                let mut key = String::from("[");

                match identity {
                    Some(identity) => js::write_string(&mut key, identity),
                    None => js::write_data(&mut key, get(item, "identity")),
                }

                key.push(',');
                js::write_data(&mut key, path);

                if item.has("value") {
                    key.push(',');
                    js::write_data(&mut key, get(item, "value"));
                }

                key.push(']');

                return self
                    .tokens
                    .get(&key)
                    .map(|token| Value::Token(Arc::clone(token)))
                    .ok_or_else(|| invalid("Unknown packed style token."));
            }
            Some("expression") => {
                let mut parts = Vec::new();

                for part in array(get(item, "parts"))? {
                    parts.push(match self.scalar(part, depth + 1)? {
                        Value::String(text) => token::Part::Text(text),
                        Value::Token(reference) => token::Part::Reference(reference),
                        Value::Binding(binding) => token::Part::Binding(binding),
                        Value::Number(_) | Value::Expression(_) => {
                            return Err(invalid("Invalid packed style expression."));
                        }
                    });
                }

                return Ok(Value::Expression(token::compose(parts)));
            }
            _ => {}
        }

        let name = get(item, "name").as_str();
        let domain = get(item, "type").as_str().and_then(Domain::parse);

        match (get(item, "variable"), name, domain) {
            (Data::Bool(true), Some(name), Some(domain)) if named(name, "--z-") => {
                Ok(Value::Binding(Arc::new(binding::Reference {
                    domain,
                    dynamic: false,
                    name: name.to_owned(),
                    zero: matches!(get(item, "zero"), Data::Bool(true)),
                })))
            }
            _ => Err(invalid("Invalid packed style value.")),
        }
    }

    fn style(&self, value: &Data, depth: usize) -> Result<Arc<NamedStyle>> {
        if depth > 64 {
            return Err(invalid("Packed style nesting exceeds 64 levels."));
        }

        let item = object(value)?;

        if !get(item, "targets").is_undefined() && self.version < 20 {
            return Err(invalid(
                "Target branches require contract version 20 or later.",
            ));
        }

        let css_output = match get(item, "cssOutput") {
            Data::Undefined => None,
            Data::String(mode) => Some(
                CssOutput::parse(mode)
                    .ok_or_else(|| invalid("Invalid packed style CSS output mode."))?,
            ),
            _ => return Err(invalid("Invalid packed style CSS output mode.")),
        };
        let composition = match get(item, "composition") {
            Data::Undefined => None,
            Data::String(mode) if self.version >= 34 => Some(
                Composition::parse(mode)
                    .ok_or_else(|| invalid("Invalid packed style composition mode."))?,
            ),
            _ => return Err(invalid("Invalid packed style composition mode.")),
        };
        let mut declarations = Vec::new();

        for value in array(get(item, "declarations"))? {
            let declaration = object(value)?;
            let property = string(get(declaration, "property"))?;

            if literal::rule(&property).is_none() && !property.starts_with("--") {
                return Err(invalid("Invalid packed style property."));
            }

            let important = match get(declaration, "important") {
                Data::Undefined => false,
                Data::Bool(important) => *important,
                _ => return Err(invalid("Invalid packed style importance.")),
            };

            declarations.push(Declaration {
                important,
                property,
                value: self.scalar(get(declaration, "value"), 0)?,
            });
        }

        let name = string(get(item, "name"))?;
        let targets = match get(item, "targets") {
            Data::Undefined => None,
            value => {
                let targets = object(value)?;

                if targets
                    .keys()
                    .any(|key| !matches!(&**key, "android" | "ios" | "native" | "web"))
                {
                    return Err(invalid("Unknown packed style target."));
                }

                let native = |key: &str| -> Result<Option<Data>> {
                    match get(targets, key) {
                        Data::Undefined => Ok(None),
                        value => {
                            object(value)?;
                            Ok(Some(crate::internal::targets::copy(value, &[], 0)?))
                        }
                    }
                };

                Some(Targets {
                    android: native("android")?,
                    ios: native("ios")?,
                    native: native("native")?,
                    order: Vec::new(),
                    web: match get(targets, "web") {
                        Data::Undefined => None,
                        value => Some(self.style(value, depth + 1)?),
                    },
                })
            }
        };
        let rules = match get(item, "rules") {
            Data::Undefined => None,
            value => {
                let mut rules = Vec::new();

                for value in array(value)? {
                    let rule = object(value)?;
                    let condition = match get(rule, "condition") {
                        Data::Undefined => None,
                        value => Some(string(value)?),
                    };

                    if condition.as_deref().is_some_and(|condition| {
                        !condition.starts_with('@') && !condition::nested(condition)
                    }) {
                        return Err(invalid("Invalid packed style condition."));
                    }

                    rules.push(Rule {
                        condition: condition.filter(|condition| !condition.is_empty()),
                        style: self.style(get(rule, "style"), depth + 1)?,
                    });
                }

                Some(rules)
            }
        };

        Ok(Arc::new(NamedStyle {
            composition,
            css_output,
            declarations,
            name,
            rules,
            targets,
        }))
    }

    fn recipe(&self, input: &Data) -> Result<Option<recipe::Definition>> {
        if input.is_undefined() {
            return Ok(None);
        }

        if self.version < 21 {
            return Err(invalid(
                "Static recipes require contract version 21 or later.",
            ));
        }

        let recipe = object(input)?;
        let mut axes: recipe::Axes = Vec::new();

        for (name, value) in object(get(recipe, "axes"))?.iter() {
            let choices: Vec<Arc<str>> = array(value)?.iter().map(string).collect::<Result<_>>()?;
            let unique = choices
                .iter()
                .enumerate()
                .all(|(index, choice)| !choices[..index].contains(choice));

            if name.is_empty() || !unique || choices.is_empty() {
                return Err(invalid("Invalid packed recipe axis."));
            }

            axes.push((Arc::clone(name), choices));
        }

        let choices = |axis: &str| {
            axes.iter()
                .find(|(name, _)| &**name == axis)
                .map(|(_, choices)| choices)
        };
        let mut defaults: recipe::Defaults = Vec::new();

        for (axis, choice) in object(get(recipe, "defaults"))?.iter() {
            let invalid_default = || invalid("Invalid packed recipe default.");
            let Some(declared) = choices(axis) else {
                return Err(invalid_default());
            };
            let selected = match choice {
                Data::Null => None,
                choice => Some(string(choice)?),
            };

            if selected
                .as_ref()
                .is_some_and(|selected| !declared.contains(selected))
            {
                return Err(invalid_default());
            }

            defaults.push((Arc::clone(axis), selected));
        }

        let mut rules = Vec::new();

        for value in array(get(recipe, "rules"))? {
            let rule = object(value)?;
            let mut matches: recipe::Matches = Vec::new();

            for value in array(get(rule, "matches"))? {
                let entry = array(value)?;
                let axis = string(entry.first().unwrap_or(&Data::Undefined))?;
                let selected: Vec<Arc<str>> = array(entry.get(1).unwrap_or(&Data::Undefined))?
                    .iter()
                    .map(string)
                    .collect::<Result<_>>()?;
                let valid = entry.len() == 2
                    && choices(&axis).is_some_and(|choices| {
                        !selected.is_empty()
                            && selected.iter().all(|choice| choices.contains(choice))
                    });

                if !valid {
                    return Err(invalid("Invalid packed recipe match."));
                }

                matches.push((axis, selected));
            }

            let styles = array(get(object(get(rule, "value"))?, "styles"))?
                .iter()
                .map(|style| self.style(style, 0))
                .collect::<Result<_>>()?;

            rules.push(recipe::Rule {
                matches,
                value: crate::style::Definition {
                    labels: None,
                    styles,
                },
            });
        }

        Ok(Some(recipe::Definition {
            axes,
            defaults,
            rules,
        }))
    }
}

const RESERVED_FIELDS: [&str; 6] = ["__proto__", "style", "className", "vars", "key", "ref"];

/// Validates packed contract data and restores live theme references without executing package
/// code.
///
/// # Errors
///
/// Returns the TypeScript messages for malformed or version-incompatible packed styles.
pub fn read(
    value: &Data,
    themes: &Record<Arc<theme::Definition>>,
    version: u32,
) -> Result<Definition> {
    let mut tokens = FxHashMap::default();

    for theme in themes.values() {
        collect(&theme.tokens, &mut tokens);
    }

    let reader = Reader {
        tokens: &tokens,
        version,
    };
    let item = object(value)?;

    if version >= 17 && get(object(get(item, "style"))?, "cssOutput").is_undefined() {
        return Err(invalid("Missing packed style CSS output mode."));
    }

    let attributes: Vec<Arc<str>> = array(get(item, "attributes"))?
        .iter()
        .map(string)
        .collect::<Result<_>>()?;
    let slots: Vec<Arc<str>> = array(get(item, "slots"))?
        .iter()
        .map(string)
        .collect::<Result<_>>()?;
    let output = get(item, "output");

    if attributes.iter().any(|name| !named(name, "data-"))
        || slots.iter().any(|name| !named(name, "--z-"))
        || !(output.is_undefined() || output.as_str() == Some("html"))
    {
        return Err(invalid("Invalid packed style ownership."));
    }

    let static_recipe = reader.recipe(get(item, "staticRecipe"))?;
    let dynamic = match get(item, "dynamic") {
        Data::Undefined => None,
        value => Some(reader.dynamic(value, &slots)?),
    };

    Ok(Definition {
        attributes,
        class_name: Some(string(get(item, "className"))?),
        dynamic,
        native_context: None,
        output: output.as_str().map(|_| Output::Html),
        packed: true,
        slots,
        static_recipe,
        style: reader.style(get(item, "style"), 0)?,
    })
}

impl Reader<'_> {
    fn dynamic(&self, value: &Data, slots: &[Arc<str>]) -> Result<Dynamic> {
        if self.version < 23 {
            return Err(invalid(
                "Dynamic native contracts require version 23 or later.",
            ));
        }

        let entry = object(value)?;
        let Some(recipe) = self.recipe(get(entry, "recipe"))? else {
            return Err(invalid("Missing packed dynamic recipe."));
        };
        let fields = |value: &Data| -> Result<Record<Arc<str>>> {
            let mut fields = Record::new();

            for (field, value) in object(value)?.iter() {
                let name = string(value)?;

                if field.is_empty() || RESERVED_FIELDS.contains(&&**field) || !slots.contains(&name)
                {
                    return Err(invalid("Invalid packed dynamic slot."));
                }

                fields.insert(Arc::clone(field), name);
            }

            Ok(fields)
        };
        let mut inputs = Slots::new();

        for (field, value) in object(get(entry, "slots"))?.iter() {
            let Value::Binding(reference) = self.scalar(value, 0)? else {
                return Err(invalid("Invalid packed dynamic scalar."));
            };

            if !matches!(reference.domain, Domain::Number | Domain::Length) {
                return Err(invalid("Invalid packed dynamic scalar."));
            }

            let mut check = Object::new();

            check.insert(Arc::clone(field), Data::string(reference.name.as_str()));
            fields(&Data::from(check))?;
            inputs.insert(Arc::clone(field), reference);
        }

        let payloads = match get(entry, "payloads") {
            Data::Undefined => None,
            value => {
                let mut seen: Vec<(Arc<str>, Arc<str>)> = Vec::new();
                let mut payloads = Vec::new();

                for value in array(value)? {
                    let payload = object(value)?;
                    let axis = string(get(payload, "axis"))?;
                    let choice = string(get(payload, "choice"))?;
                    let declared = recipe
                        .axes
                        .iter()
                        .any(|(name, choices)| *name == axis && choices.contains(&choice));

                    if !declared || seen.contains(&(Arc::clone(&axis), Arc::clone(&choice))) {
                        return Err(invalid("Invalid packed dynamic choice."));
                    }

                    seen.push((Arc::clone(&axis), Arc::clone(&choice)));

                    let slots = array(get(payload, "slots"))?
                        .iter()
                        .map(fields)
                        .collect::<Result<_>>()?;

                    payloads.push(runtime::Payload {
                        axis,
                        choice,
                        slots,
                    });
                }

                Some(payloads)
            }
        };

        if payloads
            .iter()
            .flatten()
            .any(|payload| payload.slots.len() != 1)
        {
            return Err(invalid(
                "Native payloads require one unconditional slot map.",
            ));
        }

        let default_payloads = match get(entry, "defaultPayloads") {
            Data::Undefined => None,
            value => {
                let mut defaults = Record::new();

                for (axis, value) in object(value)?.iter() {
                    let selected = recipe
                        .defaults
                        .iter()
                        .find(|(name, _)| name == axis)
                        .and_then(|(_, choice)| choice.clone());
                    let Some(payload) = payloads.iter().flatten().find(|payload| {
                        payload.axis == *axis && Some(&payload.choice) == selected.as_ref()
                    }) else {
                        return Err(invalid("Invalid packed dynamic default."));
                    };
                    let values = object(value)?;
                    let expected: Vec<&Arc<str>> = payload
                        .slots
                        .first()
                        .map(|slots| slots.keys().collect())
                        .unwrap_or_default();

                    if values.len() != expected.len()
                        || expected.iter().any(|field| !values.has(field))
                    {
                        return Err(invalid("Incomplete packed dynamic default."));
                    }

                    let mut scalars = Record::new();

                    for (field, value) in values.iter() {
                        let scalar = match value {
                            Data::String(text) => runtime::Scalar::String(Arc::clone(text)),
                            Data::Number(number) if number.is_finite() => {
                                runtime::Scalar::Number(*number)
                            }
                            _ => return Err(invalid("Invalid packed dynamic default scalar.")),
                        };

                        scalars.insert(Arc::clone(field), scalar);
                    }

                    defaults.insert(Arc::clone(axis), scalars);
                }

                Some(defaults)
            }
        };

        Ok(Dynamic {
            default_payloads,
            payloads,
            recipe,
            slots: inputs,
        })
    }
}

/// Appends a packed style as `PackedStyles.write` serializes it. Token references, expressions,
/// and bindings become data, and the style's CSS output defaults to `atomic`.
///
/// Style objects list their properties in one canonical order, since contract readers never
/// depend on it.
pub fn write(output: &mut String, definition: &Definition) {
    output.push('{');

    if let Some(dynamic) = &definition.dynamic {
        output.push_str("\"dynamic\":{\"recipe\":");
        write_recipe(output, &dynamic.recipe, definition.packed);
        output.push_str(",\"slots\":");
        js::write_object(
            output,
            dynamic.slots.iter().map(|(key, slot)| (&**key, slot)),
            |output, slot| encode_binding(output, slot),
        );

        if let Some(payloads) = &dynamic.payloads {
            output.push_str(",\"payloads\":");
            write_payloads(output, payloads);
        }

        if let Some(defaults) = &dynamic.default_payloads {
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

        output.push_str("},");
    }

    output.push_str("\"attributes\":");
    recipe::write_strings(output, &definition.attributes);

    let class_name = |output: &mut String| {
        if let Some(class_name) = &definition.class_name {
            output.push_str(",\"className\":");
            js::write_string(output, class_name);
        }
    };

    if definition.packed {
        class_name(output);
    }

    if definition.output == Some(Output::Html) {
        output.push_str(",\"output\":\"html\"");
    }

    output.push_str(",\"slots\":");
    recipe::write_strings(output, &definition.slots);

    if let Some(recipe) = &definition.static_recipe {
        output.push_str(",\"staticRecipe\":");
        write_recipe(output, recipe, definition.packed);
    }

    output.push_str(",\"style\":");
    write_style(
        output,
        &definition.style,
        Some(CssOutput::Atomic),
        definition.packed,
    );

    if !definition.packed {
        class_name(output);
    }

    output.push('}');
}

fn write_scalar(output: &mut String, value: &runtime::Scalar) {
    match value {
        runtime::Scalar::Number(number) if number.is_finite() => js::write_number(output, *number),
        runtime::Scalar::Number(_) => output.push_str("null"),
        runtime::Scalar::String(text) => js::write_string(output, text),
    }
}

fn write_payloads(output: &mut String, payloads: &[runtime::Payload]) {
    output.push('[');

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
                |output, slot| js::write_string(output, slot),
            );
        }

        output.push_str("]}");
    }

    output.push(']');
}

fn write_recipe(output: &mut String, definition: &recipe::Definition, packed: bool) {
    output.push_str("{\"axes\":");
    recipe::write_axes(output, &definition.axes);
    output.push_str(",\"defaults\":");
    recipe::write_defaults(output, &definition.defaults);
    output.push_str(",\"rules\":[");

    for (index, rule) in definition.rules.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }

        output.push_str("{\"matches\":");
        recipe::write_matches(output, &rule.matches);
        output.push_str(",\"value\":{\"styles\":[");

        for (index, style) in rule.value.styles.iter().enumerate() {
            if index > 0 {
                output.push(',');
            }

            write_style(output, style, None, packed);
        }

        output.push_str("]}}");
    }

    output.push_str("]}");
}

/// Appends a style with encoded values. `css_output` replaces a missing CSS output.
///
/// Key order follows the object that produced the style. `PackedStyles.read` lists modes first
/// and target branches before rules, while `Style.define` names conditional styles before their
/// declarations and plain styles after them, with target branches in authored order.
fn write_style(
    output: &mut String,
    style: &NamedStyle,
    css_output: Option<CssOutput>,
    packed: bool,
) {
    let css_output = style.css_output.or(css_output);

    output.push('{');

    let mut first = true;
    let mut key = |output: &mut String, name: &str| {
        if !first {
            output.push(',');
        }

        first = false;
        js::write_string(output, name);
        output.push(':');
    };
    let modes = |output: &mut String, key: &mut dyn FnMut(&mut String, &str)| {
        if let Some(composition) = style.composition {
            key(output, "composition");
            js::write_string(output, composition.as_str());
        }

        if let Some(css_output) = css_output {
            key(output, "cssOutput");
            js::write_string(output, css_output.as_str());
        }
    };

    if packed {
        modes(output, &mut key);
    }

    if style.rules.is_some() && !packed {
        key(output, "name");
        js::write_string(output, &style.name);
    }

    key(output, "declarations");
    write_declarations(output, &style.declarations);

    if style.rules.is_none() || packed {
        key(output, "name");
        js::write_string(output, &style.name);
    }

    let targets = |output: &mut String, key: &mut dyn FnMut(&mut String, &str)| {
        let Some(targets) = &style.targets else {
            return;
        };

        key(output, "targets");
        output.push('{');

        let mut first = true;
        let mut branch = |output: &mut String, name: &str| {
            if !first {
                output.push(',');
            }

            first = false;
            js::write_string(output, name);
            output.push(':');
        };
        let natives = [
            ("android", &targets.android),
            ("ios", &targets.ios),
            ("native", &targets.native),
        ];
        let natives = natives.iter().filter_map(|(name, value)| {
            Some((*name, value.as_ref().filter(|value| !value.is_undefined())?))
        });

        if packed {
            for (name, value) in natives {
                branch(output, name);
                write_data(output, value);
            }

            if let Some(web) = &targets.web {
                branch(output, "web");
                write_style(output, web, None, packed);
            }
        } else {
            let canonical = ["web", "native", "android", "ios"];
            let order: &[&str] = if targets.order.is_empty() {
                &canonical
            } else {
                &targets.order
            };
            let natives: Vec<(&str, &Data)> = natives.collect();

            for name in order {
                if *name == "web" {
                    if let Some(web) = &targets.web {
                        branch(output, "web");
                        write_style(output, web, None, packed);
                    }
                } else if let Some((name, value)) =
                    natives.iter().find(|(native, _)| native == name)
                {
                    branch(output, name);
                    write_data(output, value);
                }
            }
        }

        output.push('}');
    };

    if packed {
        targets(output, &mut key);
    }

    if let Some(rules) = &style.rules {
        key(output, "rules");
        output.push('[');

        for (index, rule) in rules.iter().enumerate() {
            if index > 0 {
                output.push(',');
            }

            output.push('{');

            if let Some(condition) = &rule.condition {
                output.push_str("\"condition\":");
                js::write_string(output, condition);
                output.push(',');
            }

            output.push_str("\"style\":");
            write_style(output, &rule.style, None, packed);
            output.push('}');
        }

        output.push(']');
    }

    if !packed {
        targets(output, &mut key);
        modes(output, &mut key);
    }

    output.push('}');
}

fn write_declarations(output: &mut String, declarations: &[Declaration]) {
    output.push('[');

    for (index, declaration) in declarations.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }

        output.push('{');

        if declaration.important {
            output.push_str("\"important\":true,");
        }

        output.push_str("\"property\":");
        js::write_string(output, &declaration.property);
        output.push_str(",\"value\":");

        match &declaration.value {
            Value::Binding(binding) => encode_binding(output, binding),
            Value::Expression(expression) => encode_expression(output, expression),
            Value::Number(number) if number.is_finite() => js::write_number(output, *number),
            Value::Number(_) => output.push_str("null"),
            Value::String(text) => js::write_string(output, text),
            Value::Token(reference) => encode_reference(output, reference),
        }

        output.push('}');
    }

    output.push(']');
}

/// Appends static data as `JSON.stringify` writes it with the packed-style replacer.
pub(crate) fn write_data(output: &mut String, value: &Data) {
    match value {
        Data::Array(items) => {
            output.push('[');

            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }

                if item.is_undefined() {
                    output.push_str("null");
                } else {
                    write_data(output, item);
                }
            }

            output.push(']');
        }
        Data::Binding(binding) => encode_binding(output, binding),
        Data::Expression(expression) => encode_expression(output, expression),
        Data::Object(object) => js::write_object(
            output,
            object.iter().filter(|(_, value)| !value.is_undefined()),
            write_data,
        ),
        Data::Token(reference) => encode_reference(output, reference),
        value => js::write_data(output, value),
    }
}
