//! The JSON boundary of graph and module compilation.
//!
//! A [`Compiler`] belongs to one host compiler object, so its caches live exactly as long as the
//! host references it. Its results mark modules whose output is the value its previous result
//! held, which lets hosts keep their decoded objects.
//!
//! Graph options mirror `Graph.compile.Options` as JSON. The `native` object holds `platform`,
//! `fonts`, `units`, `set`, `colorScheme`, `contextual`, `runtime` (the Babel emission mode), and
//! `vars`. `vars` is the text `Wire.encode` writes for `{ styles: { styles: [] }, vars }`, or the
//! same JSON as an object. A web module serializes as its transform output, and a native module as
//! `{"code","edits":[{"start","end","code","expression"}],"map"}` with UTF-16 edit offsets and
//! the source map as JSON.
//!
//! A [`Compiler`] snapshot may name a module or contract source as `0` when it is the text the
//! previous decoded snapshot held, so unchanged sources cross the boundary once. A `0` the
//! compiler cannot resolve answers `{"stale":true}`, and the host resends complete sources.

use std::fmt::Write as _;
use std::sync::Arc;

use rustc_hash::FxHashMap;
use serde_json::Value;

use crate::compiler::graph::{self, Compiled, Graph, Map, NativeOptions, Output, Resource};
use crate::compiler::internal::edits::Edit;
use crate::compiler::internal::stylesheets::Rendered;
use crate::compiler::internal::{syntax, themes};
use crate::compiler::{native, source, transform};
use crate::data::Data;
use crate::error::{Error, Result};
use crate::internal::theme::Definition;
use crate::internal::token::{Composition, CssOutput};
use crate::js::{self, Record};
use crate::web::internal::themes::Shared;

/// The sources of the last decoded snapshot, which a later snapshot names as `0`.
struct Sources {
    contracts: Option<Map<Arc<str>>>,
    modules: Map<Arc<str>>,
}

/// Decoded native sets and the text they came from.
#[derive(Clone)]
struct Vars {
    record: Record<Arc<Definition>>,
    text: String,
}

fn malformed(message: &str) -> Error {
    Error::Message(format!("Malformed graph input: {message}"))
}

/// Decodes a record of source text. An entry of `0` names the `previous` text of its key, and
/// one that `previous` lacks sets `stale`.
fn strings(
    value: Option<&Value>,
    field: &str,
    previous: Option<&Map<Arc<str>>>,
    stale: &mut bool,
) -> Result<Option<Map<Arc<str>>>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(object)) => object
            .iter()
            .map(|(key, value)| {
                if let Some(value) = value.as_str() {
                    return Ok((Arc::from(key.as_str()), Arc::from(value)));
                }

                if value.as_u64() != Some(0) {
                    return Err(malformed(field));
                }

                if let Some(text) = previous.and_then(|previous| previous.get(key.as_str())) {
                    Ok((Arc::from(key.as_str()), Arc::clone(text)))
                } else {
                    *stale = true;
                    Ok((Arc::from(key.as_str()), Arc::from("")))
                }
            })
            .collect::<Result<_>>()
            .map(Some),
        Some(_) => Err(malformed(field)),
    }
}

fn text(value: Option<&Value>) -> Option<Arc<str>> {
    value.and_then(Value::as_str).map(Arc::from)
}

/// Decodes native sets from `Wire.encode` text.
fn definitions(text: &str) -> Result<Record<Arc<Definition>>> {
    let mut record = Record::new();

    for (name, definition) in crate::wire::definitions(text)? {
        record.insert(name, definition.ok_or_else(|| malformed("native.vars"))?);
    }

    Ok(record)
}

/// Decodes native options, reusing `previous` sets when their text is unchanged.
fn native_options(
    input: &serde_json::Map<String, Value>,
    previous: Option<&Vars>,
) -> Result<(NativeOptions, Option<Vars>)> {
    let field = |name: &str| input.get(name).filter(|value| !value.is_null());
    let string = |name: &str| match field(name) {
        None => Ok(None),
        Some(Value::String(value)) => Ok(Some(Arc::from(value.as_str()))),
        Some(_) => Err(malformed(name)),
    };
    let data = |name: &str| input.get(name).map_or(Data::Undefined, Data::from_json);
    let contextual = match field("contextual") {
        None => None,
        Some(Value::Bool(value)) => Some(*value),
        Some(_) => return Err(malformed("contextual")),
    };
    let vars = match field("vars") {
        None => None,
        Some(value) => {
            let text = match value {
                Value::String(text) => text.clone(),
                Value::Object(_) => value.to_string(),
                _ => return Err(malformed("native.vars")),
            };

            match previous {
                Some(previous) if previous.text == text => Some(previous.clone()),
                _ => Some(Vars {
                    record: definitions(&text)?,
                    text,
                }),
            }
        }
    };

    Ok((
        NativeOptions {
            color_scheme: string("colorScheme")?,
            contextual,
            fonts: data("fonts"),
            platform: data("platform"),
            runtime: field("runtime")
                .and_then(Value::as_bool)
                .unwrap_or_default(),
            set: string("set")?,
            units: data("units"),
            vars: vars.as_ref().map(|vars| vars.record.clone()),
        },
        vars,
    ))
}

/// Decodes graph options from their JSON form.
///
/// # Errors
///
/// Returns a plain error for malformed input.
pub fn options(input: &Value) -> Result<graph::Options> {
    let mut stale = false;
    let (options, _) = decode(input, None, None, &mut stale)?;

    if stale {
        return Err(malformed("sources"));
    }

    Ok(options)
}

/// Decodes graph options, reusing `previous` native sets when their text is unchanged and
/// resolving `0` sources from `sources`.
fn decode(
    input: &Value,
    previous: Option<&Vars>,
    sources: Option<&Sources>,
    stale: &mut bool,
) -> Result<(graph::Options, Option<Vars>)> {
    let field = |name: &str| input.get(name).filter(|value| !value.is_null());
    let imports = match field("imports") {
        None => None,
        Some(Value::Object(imports)) => Some(
            imports
                .iter()
                .map(|(id, specifiers)| {
                    let Value::Object(specifiers) = specifiers else {
                        return Err(malformed("imports"));
                    };
                    let specifiers = specifiers
                        .iter()
                        .map(|(specifier, target)| match target {
                            Value::Null => Ok((Arc::from(specifier.as_str()), None)),
                            Value::String(target) => Ok((
                                Arc::from(specifier.as_str()),
                                Some(Arc::from(target.as_str())),
                            )),
                            _ => Err(malformed("imports")),
                        })
                        .collect::<Result<_>>()?;

                    Ok((Arc::from(id.as_str()), specifiers))
                })
                .collect::<Result<_>>()?,
        ),
        Some(_) => return Err(malformed("imports")),
    };
    // `Css.compile` orders every present composition other than `independent`.
    let composition = field("composition").map(|value| {
        value
            .as_str()
            .and_then(Composition::parse)
            .unwrap_or(Composition::Ordered)
    });
    let css_output = field("cssOutput").map(|value| value.as_str().and_then(CssOutput::parse));
    let shared = match field("shared").and_then(Value::as_str) {
        None => None,
        Some("all") => Some(Shared::All),
        Some("defaults") => Some(Shared::Defaults),
        Some(_) => return Err(malformed("shared")),
    };
    let (native, vars) = match field("native") {
        None => (None, None),
        Some(Value::Object(native)) => {
            let (native, vars) = native_options(native, previous)?;

            (Some(native), vars)
        }
        Some(_) => return Err(malformed("native")),
    };
    let options = graph::Options {
        complete: field("complete")
            .and_then(Value::as_bool)
            .unwrap_or_default(),
        compiler: field("compiler").and_then(Value::as_bool),
        composition,
        contracts: strings(
            field("contracts"),
            "contracts",
            sources.and_then(|sources| sources.contracts.as_ref()),
            stale,
        )?,
        css_output: css_output.flatten(),
        development: field("development")
            .and_then(Value::as_bool)
            .unwrap_or_default(),
        entry: text(field("entry")),
        imports,
        invalid_css_output: css_output == Some(None),
        lean: field("lean").and_then(Value::as_bool).unwrap_or_default(),
        modules: strings(
            field("modules"),
            "modules",
            sources.map(|sources| &sources.modules),
            stale,
        )?
        .unwrap_or_default(),
        native,
        references: field("references")
            .and_then(Value::as_bool)
            .unwrap_or_default(),
        reset: text(field("reset")),
        shared,
    };

    Ok((options, vars))
}

fn write_record<'r>(output: &mut String, entries: impl Iterator<Item = (&'r str, &'r str)>) {
    js::write_object(output, entries, js::write_string);
}

fn write_rendered(output: &mut String, rendered: &Rendered) {
    output.push_str("\"assets\":");
    write_record(
        output,
        rendered
            .assets
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str())),
    );
    output.push_str(",\"css\":");
    js::write_string(output, &rendered.css);
    output.push_str(",\"map\":");
    output.push_str(&rendered.map.to_json());
    output.push_str(",\"owners\":");
    write_record(
        output,
        rendered
            .owners
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str())),
    );
}

fn write_resource(output: &mut String, resource: &Resource) {
    output.push_str("{\"id\":");
    js::write_string(output, &resource.id);
    output.push(',');
    write_rendered(output, &resource.rendered);
    output.push('}');
}

/// Which records a serialized web graph module carries.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Records {
    /// Every record, for hosts that deliver token resources beside each module's stylesheet.
    #[default]
    Complete,
    /// Every record except token resources and graph scope rules. The graph's shared stylesheet
    /// holds those once, and every module would otherwise repeat them.
    Graph,
    /// Code, stylesheet, maps, and scope classes, for hosts that read no records.
    Lean,
}

/// Appends one module's transform output. Map content equal to `placeholder` is written as `0`.
///
/// With `deferred`, the class, rule, and unit records follow the module after a NUL, which JSON
/// text never holds, so a host can decode them only when read. [`Records::Graph`] leaves out
/// token resources and scope rules, and [`Records::Lean`] is not supported here.
pub fn write_module(
    output: &mut String,
    module: &transform::Output,
    placeholder: Option<&str>,
    deferred: bool,
    records: Records,
) {
    // One reservation covers every field, so the result never regrows and copies itself. Code
    // escapes its quotes, which the margin covers.
    let css_map = &module.css_map;
    output.reserve(
        module.code.len()
            + module.code.len() / 8
            + module.css.len() * 2
            + module.map.len()
            + css_map.mappings.len()
            + css_map
                .names
                .iter()
                .map(|name| name.len() + 3)
                .sum::<usize>()
            + css_map
                .sources_content
                .iter()
                .flatten()
                .flatten()
                .filter(|content| placeholder != Some(content.as_str()))
                .map(|content| content.len() + content.len() / 8)
                .sum::<usize>()
            + module
                .classes
                .iter()
                .map(|(name, value)| name.len() + value.len() + 6)
                .sum::<usize>()
            + module
                .rules
                .iter()
                .map(|(name, rule)| name.len() + rule.len() + 6)
                .sum::<usize>()
            + module
                .units
                .iter()
                .map(|(key, decision)| key.len() + decision.name.len() + 16)
                .sum::<usize>()
            + 1024,
    );
    output.push('{');

    if !deferred {
        write_classes(output, module);
        output.push(',');
    }

    output.push_str("\"code\":");
    js::write_string(output, &module.code);
    output.push_str(",\"css\":");
    js::write_string(output, &module.css);
    output.push_str(",\"cssMap\":");
    module.css_map.write_json(output, placeholder);
    output.push_str(",\"map\":");
    output.push_str(&module.map);

    if !deferred {
        output.push(',');
        write_rules(output, module, records);
    }

    if let Some(resources) = module.shared.as_ref().filter(|_| records != Records::Graph) {
        output.push_str(",\"shared\":[");

        for (index, resource) in resources.iter().enumerate() {
            if index > 0 {
                output.push(',');
            }

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

                    output.push_str("{\"conditions\":[");

                    for (index, condition) in rule.conditions.iter().enumerate() {
                        if index > 0 {
                            output.push(',');
                        }

                        js::write_string(output, condition);
                    }

                    output.push_str("],\"property\":");
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

        output.push(']');
    }

    if !deferred {
        output.push(',');
        write_units(output, module);
    }

    output.push_str(",\"vars\":");
    write_record(
        output,
        module
            .vars
            .iter()
            .map(|(name, value)| (&**name, value.as_str())),
    );
    output.push('}');

    if deferred {
        output.push_str("\0{");
        write_classes(output, module);
        output.push(',');
        write_rules(output, module, records);
        output.push(',');
        write_units(output, module);
        output.push('}');
    }
}

/// Appends one module's code, stylesheet, maps, and scope classes, without the records only
/// contract publishers and per-module token hosts read.
fn write_lean_module(output: &mut String, module: &transform::Output) {
    output.reserve(module.code.len() * 9 / 8 + module.css.len() * 2 + module.map.len() + 1024);
    output.push_str("{\"code\":");
    js::write_string(output, &module.code);
    output.push_str(",\"css\":");
    js::write_string(output, &module.css);
    output.push_str(",\"cssMap\":");
    module.css_map.write_json(output, None);
    output.push_str(",\"map\":");
    output.push_str(&module.map);
    output.push_str(",\"vars\":");
    write_record(
        output,
        module
            .vars
            .iter()
            .map(|(name, value)| (&**name, value.as_str())),
    );
    output.push('}');
}

fn write_classes(output: &mut String, module: &transform::Output) {
    output.push_str("\"classes\":");
    write_record(
        output,
        module
            .classes
            .iter()
            .map(|(name, value)| (&**name, value.as_str())),
    );
}

fn write_rules(output: &mut String, module: &transform::Output, records: Records) {
    output.push_str("\"rules\":");
    write_record(
        output,
        module
            .rules
            .iter()
            // Scope rules are the graph's, which every module repeats for collision checks.
            .filter(|(name, _)| records != Records::Graph || !name.starts_with("@scope:"))
            .map(|(name, rule)| (name.as_str(), rule.as_str())),
    );
}

fn write_units(output: &mut String, module: &transform::Output) {
    output.push_str("\"units\":[");

    for (index, (key, decision)) in module.units.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }

        output.push('[');
        js::write_string(output, key);
        output.push_str(if decision.borrowed {
            ",true,"
        } else {
            ",false,"
        });
        js::write_string(output, &decision.name);
        output.push(']');
    }

    output.push(']');
}

fn write_edits(output: &mut String, edits: &[Edit]) {
    output.push('[');

    for (index, edit) in edits.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }

        let _ = write!(
            output,
            "{{\"start\":{},\"end\":{},\"code\":",
            edit.start, edit.end
        );
        js::write_string(output, &edit.code);
        output.push_str(if edit.expression {
            ",\"expression\":true}"
        } else {
            ",\"expression\":false}"
        });
    }

    output.push(']');
}

/// Appends one native module: its code, adapter edits, and source map.
pub fn write_native_module(output: &mut String, module: &native::Output) {
    output.push_str("{\"code\":");
    js::write_string(output, &module.code);
    output.push_str(",\"edits\":");
    write_edits(output, &module.edits);
    output.push_str(",\"map\":");
    output.push_str(&module.map);
    output.push('}');
}

/// Serializes a graph result. Modules whose output is the value `written` holds for their
/// identity become `0`, and web modules carry the given `records`.
pub fn write_output(
    result: &Output,
    written: Option<&FxHashMap<Arc<str>, Compiled>>,
    records: Records,
) -> String {
    let mut output = String::from("{\"contracts\":");

    write_record(
        &mut output,
        result
            .contracts
            .iter()
            .map(|(id, contract)| (&**id, contract.as_str())),
    );
    output.push_str(",\"dependencies\":");
    js::write_object(
        &mut output,
        result
            .dependencies
            .iter()
            .map(|(id, targets)| (&**id, targets)),
        |output, targets| {
            output.push('[');

            for (index, target) in targets.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }

                js::write_string(output, target);
            }

            output.push(']');
        },
    );
    output.push_str(",\"modules\":");
    js::write_object(
        &mut output,
        result
            .modules
            .iter()
            .map(|(id, module)| (&**id, (id, module))),
        |output, (id, module)| {
            let same = written
                .and_then(|written| written.get(&**id))
                .is_some_and(|written| written.same(module));

            match module {
                _ if same => output.push('0'),
                Compiled::Native(module) => write_native_module(output, module),
                Compiled::Web(module) if records == Records::Lean => {
                    write_lean_module(output, module);
                }
                Compiled::Web(module) => write_module(output, module, None, false, records),
            }
        },
    );

    if !result.packed.is_empty() {
        output.push_str(",\"packed\":[");

        for (index, resource) in result.packed.iter().enumerate() {
            if index > 0 {
                output.push(',');
            }

            write_resource(&mut output, resource);
        }

        output.push(']');
    }

    if let Some(reset) = &result.reset {
        output.push_str(",\"reset\":");
        write_resource(&mut output, reset);
    }

    if let Some(shared) = &result.shared {
        output.push_str(",\"shared\":{");
        write_rendered(&mut output, shared);
        output.push('}');
    }

    output.push('}');
    output
}

/// Compiles a snapshot without retained state.
///
/// # Errors
///
/// Returns the graph's compilation errors and malformed input.
pub fn compile(input: &Value) -> Result<String> {
    let options = options(input)?;

    Ok(write_output(
        &*graph::compile(&options)?,
        None,
        records(&options),
    ))
}

/// The records a graph's hosts read from its web modules.
fn records(options: &graph::Options) -> Records {
    if options.lean {
        Records::Lean
    } else if options.entry.is_none() {
        Records::Graph
    } else {
        Records::Complete
    }
}

/// The bound on module outputs a host keeps decoded across snapshots.
const WRITTEN: usize = 256;

/// An incremental graph compiler with the result of its previous snapshot.
#[derive(Default)]
pub struct Compiler {
    graph: Graph,
    /// The snapshot text that produced `previous`. The graph is deterministic, so the same text
    /// answers before decoding.
    input: Option<Box<str>>,
    /// The records the written modules were serialized with.
    records: Records,
    previous: Option<Arc<Output>>,
    /// The sources of the last decoded snapshot.
    sources: Option<Sources>,
    /// The native sets of the last compilation, reused while their text is unchanged so the
    /// graph compares them by identity as it compares JavaScript values.
    vars: Option<Vars>,
    /// The last output written for each module identity. Hosts keep the decoded value of each,
    /// since alternating snapshots of one graph share most modules.
    written: FxHashMap<Arc<str>, Compiled>,
}

impl Compiler {
    /// Compiles a snapshot of JSON graph options. A result identical to the previous one
    /// serializes as `{"same":true}`, and failures as an error result.
    ///
    /// A module whose output was the last one written for its identity serializes as `0`. Past
    /// [`WRITTEN`] identities, the result carries `"prune":true` and only its own modules stay
    /// written, so hosts drop the other decoded modules.
    pub fn compile(&mut self, input: &str) -> String {
        if self.previous.is_some() && self.input.as_deref() == Some(input) {
            return "{\"same\":true}".to_owned();
        }

        let mut stale = false;
        let result = serde_json::from_str::<Value>(input)
            .map_err(|error| Error::Message(error.to_string()))
            .and_then(|input| {
                decode(
                    &input,
                    self.vars.as_ref(),
                    self.sources.as_ref(),
                    &mut stale,
                )
            })
            .and_then(|(options, vars)| {
                if stale {
                    return Err(Error::Message(String::new()));
                }

                self.sources = Some(Sources {
                    contracts: options.contracts.clone(),
                    modules: options.modules.clone(),
                });

                let result = self.graph.compile(&options)?;

                self.vars = vars;
                Ok((result, records(&options)))
            });

        match result {
            Ok((result, records)) => {
                // Hosts decode modules with different records differently, so none reuses another.
                if records != self.records {
                    self.records = records;
                    self.written.clear();
                }

                let same = self
                    .previous
                    .as_ref()
                    .is_some_and(|previous| Arc::ptr_eq(previous, &result));

                self.input = Some(input.into());

                if same {
                    return "{\"same\":true}".to_owned();
                }

                let mut written = write_output(&result, Some(&self.written), records);

                for (id, module) in &result.modules {
                    self.written.insert(Arc::clone(id), module.clone());
                }

                if self.written.len() > WRITTEN {
                    self.written
                        .retain(|id, _| result.modules.contains_key(&**id));
                    written.pop();
                    written.push_str(",\"prune\":true}");
                }

                self.previous = Some(result);
                written
            }
            Err(_) if stale => {
                self.input = None;
                "{\"stale\":true}".to_owned()
            }
            Err(error) => {
                self.input = None;
                crate::api::error_json(&error)
            }
        }
    }
}

/// Reads a library contract and lists each packed stylesheet section's import chain, which hosts
/// resolve before compiling the graph.
///
/// # Errors
///
/// Returns the contract reader's validation errors.
pub fn dependencies(input: &Value) -> Result<String> {
    let field = |name: &str| input.get(name).and_then(Value::as_str).unwrap_or_default();
    let identifier = |value: &str| crate::compiler::internal::identifiers::read(value);
    let validate =
        |filename: &str, css: &str| crate::compiler::internal::at_rules::validate(css, filename);
    let hooks = crate::compiler::internal::contract::Hooks {
        identifier: &identifier,
        validate: &validate,
    };
    let library = crate::compiler::internal::contract::read(
        field("contract"),
        &mut FxHashMap::default(),
        field("moduleId"),
        &hooks,
    )?;
    let mut output = String::from("{\"dependencies\":[");

    for (index, section) in library.stylesheets.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }

        output.push('[');

        for (index, specifier) in section.dependency.iter().flatten().enumerate() {
            if index > 0 {
                output.push(',');
            }

            js::write_string(&mut output, specifier);
        }

        output.push(']');
    }

    output.push_str("]}");

    Ok(output)
}

/// Compiles one module for an explicit native target, as `Native.compile` does.
///
/// The input holds `moduleId`, `source`, and the native options of a graph. `context: true`
/// extracts with an empty graph context, as the Babel adapter supplies one. The output is
/// `{"code","edits","map","recipes"}`: `map` is the source map text and `recipes` the
/// `JSON.stringify` form of the recipe tables.
///
/// # Errors
///
/// Returns extraction errors, `Native.CompileError` for unsupported native source, and the
/// table errors of [`native::compile`].
pub fn native_compile(input: &Value) -> Result<String> {
    let Value::Object(object) = input else {
        return Err(malformed("native"));
    };
    let field = |name: &str| object.get(name).filter(|value| !value.is_null());
    let module_id = field("moduleId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let source = field("source").and_then(Value::as_str).unwrap_or_default();
    let (native, _) = native_options(object, None)?;
    let context = themes::Context::default();
    let context = (field("context").and_then(Value::as_bool) == Some(true)).then_some(&context);
    let allocator = oxc_allocator::Allocator::default();
    let parsed = syntax::parse(&allocator, source, module_id);
    let extracted = source::extract(
        &allocator,
        &source::Options {
            compiler: None,
            context,
            module_id,
            parsed: Some(&parsed),
            source,
            target: source::Target::Native,
        },
    )?;
    let output = native::compile(
        &native::Options {
            color_scheme: native.color_scheme.as_deref(),
            context,
            contextual: native.contextual == Some(true),
            fonts: native.fonts,
            module_id,
            platform: native.platform,
            runtime: native.runtime,
            set: native.set.as_deref(),
            shared: None,
            source,
            units: native.units,
            vars: native.vars.as_ref(),
        },
        &extracted,
        &parsed,
    )?;
    let mut written = String::with_capacity(output.code.len() * 2 + output.map.len() * 2);

    written.push_str("{\"code\":");
    js::write_string(&mut written, &output.code);
    written.push_str(",\"edits\":");
    write_edits(&mut written, &output.edits);
    written.push_str(",\"map\":");
    js::write_string(&mut written, &output.map);
    written.push_str(",\"recipes\":");
    js::write_object(&mut written, output.recipes.iter(), |output, definition| {
        definition.write_json(output);
    });
    written.push('}');

    Ok(written)
}

/// Compiles one module outside a graph, as `Transform.compile` does.
///
/// A `separate` source replaces the input's `source` field, and both maps then write `0` for its
/// content, which the host restores.
///
/// # Errors
///
/// Returns extraction and emission errors, and the TypeScript message for native targets.
pub fn transform(input: &Value, separate: Option<&str>) -> Result<String> {
    let field = |name: &str| input.get(name).filter(|value| !value.is_null());

    if field("target").and_then(Value::as_str) == Some("native") {
        return Err(Error::Message(
            "Use Native.compile for native source output.".to_owned(),
        ));
    }

    let module_id = field("moduleId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let source = separate
        .or_else(|| field("source").and_then(Value::as_str))
        .unwrap_or_default();
    let compiler = field("compiler").and_then(Value::as_bool);
    let options = options(input)?;
    let allocator = oxc_allocator::Allocator::default();
    let parsed = crate::compiler::internal::syntax::parse(&allocator, source, module_id);
    let extracted = crate::compiler::source::extract(
        &allocator,
        &crate::compiler::source::Options {
            compiler,
            context: None,
            module_id,
            parsed: Some(&parsed),
            source,
            target: crate::compiler::source::Target::Web,
        },
    )?;
    let output = transform::compile(
        &transform::Options {
            compiler: compiler != Some(false),
            composition: options.composition,
            css_output: options.css_output,
            deferred_scopes: false,
            development: options.development,
            invalid_css_output: options.invalid_css_output,
            module_id,
            owners: None,
            placeholder: separate,
            referenced: None,
            schemes: field("schemes").and_then(Value::as_bool),
            shared: options.shared,
            source,
            style_classes: None,
        },
        &extracted,
        &parsed,
        None,
    )?;
    // The writer reserves the whole result at once.
    let mut written = String::new();

    write_module(&mut written, &output, separate, true, Records::Complete);

    Ok(written)
}

/// Validates a host stylesheet and renames the at-keywords the host's Lightning CSS binding
/// cannot round-trip, as `AtRules.transform` does before that binding parses it.
///
/// The input holds `code` and `visitor`, which marks anonymous import layers. The result is
/// `null` when the original code parses unchanged, or the renamed `code` with the `features`,
/// `import`, `palette`, and `property` markers that restore the parsed output.
///
/// # Errors
///
/// Returns the first validation failure.
pub fn transport(input: &Value) -> Result<String> {
    let code = input
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let visitor = input.get("visitor").and_then(Value::as_bool) == Some(true);
    let Some(transport) = crate::compiler::internal::at_rules::Transport::prepare(code, visitor)?
    else {
        return Ok("null".to_owned());
    };
    let mut output = String::with_capacity(transport.code.len() + 128);

    output.push_str("{\"code\":");
    js::write_string(&mut output, &transport.code);
    output.push_str(",\"features\":");
    js::write_string(&mut output, &transport.features);
    output.push_str(",\"import\":");
    js::write_string(&mut output, &transport.import);
    output.push_str(",\"palette\":");
    js::write_string(&mut output, &transport.palette);
    output.push_str(",\"property\":");
    js::write_string(&mut output, &transport.property);
    output.push('}');

    Ok(output)
}
