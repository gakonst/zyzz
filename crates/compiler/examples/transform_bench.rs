//! Times parsing, extraction, transformation, and output encoding for `transform.compile` inputs.
//!
//! Each argument names a JSON file holding the operation input, such as
//! `{"composition":"independent","moduleId":"app.ts","source":"..."}`.

#![expect(
    clippy::print_stdout,
    clippy::disallowed_methods,
    reason = "A developer timing tool reads prepared inputs, reads the clock, and prints a report."
)]

use std::time::{Duration, Instant};

use compiler::api;
use compiler::compiler::internal::syntax;
use compiler::compiler::{handles, source, transform};
use compiler::internal::token::Composition;
use oxc_allocator::Allocator;
use serde_json::Value;

// Timings and profiles use the allocator the Node binding links.
#[global_allocator]
static ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

/// Runs a closure repeatedly and reports the median duration and sample count.
fn time(mut operation: impl FnMut()) -> (Duration, usize) {
    for _ in 0..5 {
        operation();
    }

    let mut samples = Vec::new();
    let deadline = Instant::now() + Duration::from_millis(1500);

    while samples.len() < 20 || (Instant::now() < deadline && samples.len() < 2000) {
        let start = Instant::now();

        operation();
        samples.push(start.elapsed());
    }

    samples.sort();

    (
        samples.get(samples.len() / 2).copied().unwrap_or_default(),
        samples.len(),
    )
}

/// The decoded fields of one input file.
struct Input {
    composition: Option<Composition>,
    module_id: String,
    source: String,
    /// Options followed by a NUL and the source, as `Transform.compile` sends them.
    text: String,
}

fn read(path: &str) -> Input {
    let text = std::fs::read_to_string(path).expect("transform input");
    let mut value: Value = serde_json::from_str(&text).expect("JSON input");
    let field = |name: &str| value.get(name).and_then(Value::as_str).map(str::to_owned);
    let composition = field("composition").and_then(|value| Composition::parse(&value));
    let module_id = field("moduleId").unwrap_or_default();
    let source = field("source").unwrap_or_default();

    if let Some(object) = value.as_object_mut() {
        object.remove("source");
    }

    Input {
        composition,
        module_id,
        text: format!("{value}\0{source}"),
        source,
    }
}

fn options(input: &Input) -> transform::Options<'_, '_> {
    transform::Options {
        compiler: true,
        composition: input.composition,
        css_output: None,
        deferred_scopes: false,
        development: false,
        invalid_css_output: false,
        module_id: &input.module_id,
        owners: None,
        placeholder: None,
        referenced: None,
        schemes: None,
        shared: None,
        source: &input.source,
        style_classes: None,
    }
}

fn extract<'a>(
    allocator: &'a Allocator,
    input: &'a Input,
    parsed: &'a syntax::Parsed<'a>,
) -> source::Extracted<'a> {
    source::extract(
        allocator,
        &source::Options {
            compiler: None,
            context: None,
            module_id: &input.module_id,
            parsed: Some(parsed),
            source: &input.source,
            target: source::Target::Web,
        },
    )
    .expect("extracted source")
}

fn main() {
    let mut arguments: Vec<String> = std::env::args().skip(1).collect();

    // `--profile <stage> <iterations>` repeats one stage without timing, for instruction profilers.
    if arguments
        .first()
        .is_some_and(|argument| argument == "--profile")
    {
        let stage = arguments.get(1).cloned().unwrap_or_default();
        let iterations: usize = arguments
            .get(2)
            .and_then(|count| count.parse().ok())
            .unwrap_or(10);

        for path in arguments.drain(3..) {
            let input = read(&path);

            for _ in 0..iterations {
                if stage == "total" {
                    std::hint::black_box(api::call("transform.compile", &input.text));
                    continue;
                }

                let allocator = Allocator::default();
                let parsed = syntax::parse(&allocator, &input.source, &input.module_id);

                if stage == "parse" {
                    std::hint::black_box(&parsed);
                    continue;
                }

                let extracted = extract(&allocator, &input, &parsed);

                if stage == "extract" {
                    std::hint::black_box(&extracted);
                    continue;
                }

                std::hint::black_box(
                    transform::compile(&options(&input), &extracted, &parsed, None)
                        .expect("transformed"),
                );
            }
        }

        return;
    }

    println!("name\tparse\textract\ttransform\twrite\ttotal\tsamples");

    for path in arguments {
        let input = read(&path);
        let (parse, samples) = time(|| {
            let allocator = Allocator::default();

            std::hint::black_box(syntax::parse(&allocator, &input.source, &input.module_id));
        });
        let (extracting, _) = time(|| {
            let allocator = Allocator::default();
            let parsed = syntax::parse(&allocator, &input.source, &input.module_id);

            std::hint::black_box(extract(&allocator, &input, &parsed));
        });
        let (transforming, _) = time(|| {
            let allocator = Allocator::default();
            let parsed = syntax::parse(&allocator, &input.source, &input.module_id);
            let extracted = extract(&allocator, &input, &parsed);

            std::hint::black_box(
                transform::compile(&options(&input), &extracted, &parsed, None)
                    .expect("transformed"),
            );
        });
        let allocator = Allocator::default();
        let parsed = syntax::parse(&allocator, &input.source, &input.module_id);
        let extracted = extract(&allocator, &input, &parsed);
        let output =
            transform::compile(&options(&input), &extracted, &parsed, None).expect("transformed");
        let (writing, _) = time(|| {
            let mut written = String::new();

            handles::write_module(
                &mut written,
                &output,
                None,
                true,
                handles::Records::Complete,
            );
            std::hint::black_box(written);
        });
        let (total, _) = time(|| {
            std::hint::black_box(api::call("transform.compile", &input.text));
        });
        let name = std::path::Path::new(&path)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or_default()
            .to_owned();

        // Stage columns are cumulative through each stage, so the differences are each stage's cost.
        println!(
            "{name}\t{parse:?}\t{extracting:?}\t{transforming:?}\t{writing:?}\t{total:?}\t{samples}"
        );
    }
}
