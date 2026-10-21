//! Verifies source analysis stages through the public crate functions, from module text to the
//! applications, names, and resolved imports the transform consumes. Expected values come from
//! the TypeScript compiler on the same sources.

use std::fmt::Write as _;
use std::sync::Arc;

use compiler::compiler::internal::{applications, names, relative, syntax};
use compiler::compiler::source::Call;
use oxc_allocator::Allocator;

/// Definition calls for every `style(...)` in a source, named by start offset.
fn calls<'a>(source: &str) -> Vec<Call<'a>> {
    source
        .match_indices("style(")
        .filter(|(start, _)| {
            !source[..*start].ends_with(|character: char| character.is_ascii_alphanumeric())
        })
        .map(|(start, _)| {
            let mut depth = 0;
            let end = source[start + 5..]
                .char_indices()
                .find_map(|(index, character)| {
                    match character {
                        '(' | '{' | '[' => depth += 1,
                        ')' | '}' | ']' => depth -= 1,
                        _ => {}
                    }

                    (depth == 0).then_some(start + 5 + index + 1)
                })
                .unwrap_or(source.len());

            Call {
                end: u32::try_from(end).unwrap_or_default(),
                name: Arc::from(format!("style-{start}")),
                start: u32::try_from(start).unwrap_or_default(),
                ..Call::default()
            }
        })
        .collect()
}

fn applications(source: &str) -> String {
    let allocator = Allocator::default();
    let parsed = syntax::parse(&allocator, source, "app.tsx");
    let calls = calls(source);
    let Some(applications) = applications::create(
        parsed.program,
        &parsed.semantic,
        &calls,
        applications::Options::default(),
    ) else {
        return "none".to_owned();
    };
    let mut dead: Vec<String> = applications
        .dead()
        .iter()
        .map(ToString::to_string)
        .collect();
    let mut output = String::new();

    dead.sort();

    let definitions = applications.definitions();

    let _ = writeln!(output, "dead: {dead:?}");

    for (name, initialized) in definitions.values.iter() {
        let _ = writeln!(output, "fold {name}: initialized {initialized}");
    }

    for namespace in &definitions.namespaces {
        let _ = writeln!(output, "erase namespace at {}", namespace.start);
    }

    for application in applications.find() {
        let _ = writeln!(
            output,
            "apply {} at {}..{} initialized {} terminal {}",
            application.name,
            application.start,
            application.end,
            application.initialized,
            application.terminal
        );
    }

    output
}

mod create {
    use super::applications;

    #[test]
    fn folds_terminal_applications_and_drops_unread_definitions() {
        let source = "import { style } from 'zyzz'
const card = style({ color: 'red' })
const unused = style({ color: 'blue' })
const group = { a: style({ padding: 0 }), b: style({ margin: 0 }) }
namespace styles {
  export const title = style({ fontSize: 1 })
  export const body = style({ fontSize: 2 })
}
export function App() {
  return <div className={card().className}><p {...styles.title()} /><span {...group.a()} />{styles.body({ className: 'x' })}<Comp x={group} /></div>
}
const early = later()
const later = style({ color: 'green' })
";

        insta::assert_snapshot!(applications(source), @r#"
        dead: ["style-81"]
        fold style-42: initialized false
        fold style-81: initialized true
        fold style-216: initialized false
        fold style-261: initialized false
        fold style-497: initialized false
        apply style-42 at 335..341 initialized false terminal true
        apply style-216 at 360..374 initialized false terminal true
        apply style-261 at 402..433 initialized false terminal false
        apply style-497 at 475..482 initialized false terminal false
        "#);
    }

    #[test]
    fn keeps_every_definition_when_the_module_evaluates_code() {
        let source = "import { style } from 'zyzz'
const card = style({ color: 'red' })
eval('card')
card()
";

        insta::assert_snapshot!(applications(source), @"dead: []");
    }
}

mod collect {
    use super::*;

    #[test]
    fn names_calls_by_their_enclosing_declarations() {
        let source = "import { style } from 'zyzz'
const a = style({})
namespace ns { export const b = style({ x: { y: style() } }) }
function Component() { const c = style() }
export default { d: style(), 'e-f': style(), 1: style() }
const { g = style() } = {}
style()
";
        let allocator = Allocator::default();
        let parsed = syntax::parse(&allocator, source, "names.tsx");
        let mut names: Vec<(u32, String)> = names::collect(&parsed.semantic)
            .iter()
            .map(|(start, name)| (start, name.to_owned()))
            .collect();

        names.sort_unstable();

        insta::assert_debug_snapshot!(names, @r#"
        [
            (
                39,
                "a",
            ),
            (
                81,
                "ns-b",
            ),
            (
                97,
                "ns-b-x-y",
            ),
            (
                145,
                "Component-c",
            ),
            (
                175,
                "d",
            ),
            (
                191,
                "e_2d_f",
            ),
            (
                203,
                "1",
            ),
            (
                225,
                "g",
            ),
            (
                240,
                "style",
            ),
        ]
        "#);
    }
}

mod resolve {
    use super::*;

    fn resolve(specifier: &str, modules: &[&str]) -> String {
        match relative::resolve("src/m.ts", specifier, |path| modules.contains(&path)) {
            Ok(Some(path)) => path,
            Ok(None) => "external".to_owned(),
            Err(error) => error.text(),
        }
    }

    #[test]
    fn resolves_supplied_modules_with_script_extensions() {
        insta::assert_snapshot!(resolve("./a", &["src/a.ts"]), @"src/a.ts");
        insta::assert_snapshot!(resolve("./a.js", &["src/a.ts"]), @"src/a.ts");
        insta::assert_snapshot!(resolve("./b", &["src/b/index.tsx"]), @"src/b/index.tsx");
        insta::assert_snapshot!(resolve("./c.mjs", &["src/c.mts"]), @"src/c.mts");
    }

    #[test]
    fn leaves_packages_and_assets_to_the_host() {
        insta::assert_snapshot!(resolve("pkg", &[]), @"external");
        insta::assert_snapshot!(resolve("./style.css", &[]), @"external");
    }

    #[test]
    fn rejects_ambiguous_missing_and_escaping_imports() {
        insta::assert_snapshot!(resolve("./a", &["src/a.ts", "src/a.tsx"]), @"Ambiguous source import: ./a");
        insta::assert_snapshot!(resolve("./missing", &[]), @"Missing source module: ./missing");
        insta::assert_snapshot!(resolve("../../x", &[]), @"Source import escapes the supplied graph.");
    }
}
