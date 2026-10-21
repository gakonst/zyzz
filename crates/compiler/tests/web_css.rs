//! Integration scenarios for web CSS emission through `web::css::compile` and the JSON wire.

use std::sync::Arc;

use compiler::data::{Data, Object};
use compiler::error::Error;
use compiler::internal::token::{Composition, CssOutput};
use compiler::internal::{identity, shorthands};
use compiler::style::{self, Vars};
use compiler::vars;
use compiler::web::css::{self, Names, Options, Output};
use compiler::web::internal::class_name::{Registry, Visibility};
use compiler::web::internal::contributions::{Definition, ImportLayer, Kind};
use compiler::web::internal::themes::{Scope, Shared};
use compiler::wire;

/// Converts JSON test input into evaluated JavaScript data.
fn data(value: serde_json::Value) -> Data {
    match value {
        serde_json::Value::Null => Data::Null,
        serde_json::Value::Bool(value) => Data::Bool(value),
        serde_json::Value::Number(number) => Data::Number(number.as_f64().unwrap_or(f64::NAN)),
        serde_json::Value::String(text) => Data::from(text),
        serde_json::Value::Array(items) => {
            Data::Array(Arc::new(items.into_iter().map(data).collect()))
        }
        serde_json::Value::Object(entries) => Data::from(Object::from_entries(
            entries
                .into_iter()
                .map(|(key, value)| (Arc::from(key), data(value))),
        )),
    }
}

fn define(styles: serde_json::Value) -> style::Definition {
    style::define(&data(styles), &style::Options::default()).expect("valid styles")
}

fn classes(output: &Output) -> String {
    output
        .classes
        .iter()
        .map(|(name, class)| format!("{name}: {class}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn message(error: &Error) -> String {
    error.text()
}

#[test]
fn compile_shares_atomic_domains_in_authored_order() {
    let definition = define(serde_json::json!({
        "card": { "color": "red", "padding": "8px" },
        "button": { "color": "red", "padding": "4px", "paddingInline": "12px" },
    }));
    let output = css::compile(
        &Options {
            styles: &definition.styles,
            ..Options::default()
        },
        None,
    )
    .expect("compiled");

    insta::assert_snapshot!(classes(&output), @"
    card: z_0 z_1
    button: z_0 z_2 z_3
    ");
    insta::assert_snapshot!(output.css, @"
    .z_0{color:red;}
    .z_1{padding:8px;}
    .z_2{padding:4px;}
    .z_3{padding-inline:12px;}
    ");
}

#[test]
fn compile_keeps_readable_names_in_development() {
    let definition = define(serde_json::json!({
        "card": { "color": "red", "padding": "8px" },
        "button": { "color": "red", "padding": "4px" },
    }));
    let atomic = css::compile(
        &Options {
            development: true,
            styles: &definition.styles,
            ..Options::default()
        },
        None,
    )
    .expect("compiled");

    insta::assert_snapshot!(classes(&atomic), @"
    card: z-text-red z-card-p-1
    button: z-text-red z-button-p-0
    ");

    let grouped = css::compile(
        &Options {
            css_output: Some(CssOutput::Grouped),
            development: true,
            styles: &definition.styles,
            ..Options::default()
        },
        None,
    )
    .expect("compiled");

    insta::assert_snapshot!(classes(&grouped), @"
    card: z-card
    button: z-button
    ");
}

#[test]
fn compile_groups_independent_styles_with_shared_declarations() {
    let definition = define(serde_json::json!({
        "first": { "backgroundColor": "#fff", "display": "block", "padding": "1px" },
        "second": { "backgroundColor": "#fff", "display": "block", "padding": "2px" },
        "third": { "backgroundColor": "#fff", "display": "block", "padding": "2px" },
    }));
    let output = css::compile(
        &Options {
            composition: Some(Composition::Independent),
            css_output: Some(CssOutput::Grouped),
            styles: &definition.styles,
            ..Options::default()
        },
        None,
    )
    .expect("compiled");

    insta::assert_snapshot!(classes(&output), @"
    first: z_0 z_1
    second: z_0 z_2
    third: z_0 z_2
    ");
    insta::assert_snapshot!(output.css, @"
    .z_0{background-color:#fff;display:block;}
    .z_1{padding:1px;}
    .z_2{padding:2px;}
    ");
}

#[test]
fn compile_names_independent_units_across_a_shared_registry() {
    let first = define(serde_json::json!({ "a": { "color": "red", "margin": "0px" } }));
    let second = define(serde_json::json!({ "b": { "color": "red", "margin": "1px" } }));
    let options = |styles| Options {
        composition: Some(Composition::Independent),
        styles,
        ..Options::default()
    };
    let mut registry = Registry::new();
    let one = {
        let mut units = registry.scope("one.ts", "q1", Visibility::All);

        css::compile(&options(&first.styles), Some(&mut units)).expect("first module")
    };
    let two = {
        let mut units = registry.scope("two.ts", "q2", Visibility::All);

        css::compile(&options(&second.styles), Some(&mut units)).expect("second module")
    };

    insta::assert_snapshot!(classes(&one), @"a: z_q10 z_q11");
    insta::assert_snapshot!(classes(&two), @"b: z_q10 z_q21");
    insta::assert_snapshot!(format!("{:?}", two.units), @r#"{"\ncolor:red;": Decision { borrowed: true, name: "z_q10" }, "\nmargin:1px;": Decision { borrowed: false, name: "z_q21" }}"#);

    let mut restored = Registry::new();

    insta::assert_snapshot!(restored.restore("two.ts", &two.units, &Visibility::All), @"false");
    insta::assert_snapshot!(restored.restore("one.ts", &one.units, &Visibility::All), @"true");
    insta::assert_snapshot!(restored.restore("two.ts", &two.units, &Visibility::All), @"true");
}

#[test]
fn compile_keeps_inactive_conditions_outside_class_rules() {
    let definition = define(serde_json::json!({
        "link": {
            "color": "blue",
            "&:hover": { "color": "red" },
            "@media (min-width: 40rem)": { "color": "green" },
        },
    }));
    let output = css::compile(
        &Options {
            styles: &definition.styles,
            ..Options::default()
        },
        None,
    )
    .expect("compiled");

    insta::assert_snapshot!(classes(&output), @"link: z_0 z_1 z_2");
    insta::assert_snapshot!(output.css, @"
    .z_0{color:blue;}
    .z_1{&:hover{color:red;}}
    @media (min-width: 40rem){.z_2{color:green;}}
    ");
}

#[test]
fn compile_emits_variable_scopes_with_fallbacks() {
    let set = vars::define(
        &data(serde_json::json!({
            "color": {
                "ink": { "default": "black", "@media (prefers-contrast: more)": "#000" },
                "accent": { "light": "#06c", "dark": "#9cf" },
            },
        })),
        None,
        Some("brand"),
    )
    .expect("variable set");
    let definition = style::define(
        &data(serde_json::json!({
            "text": { "color": "ink", "borderColor": "accent", "borderStyle": "solid" },
        })),
        &style::Options {
            locations: &[],
            vars: Some(Vars::Variables(&set)),
        },
    )
    .expect("styles");
    let scopes = [(Arc::from("brand"), Scope::Definition(set.metadata.clone()))];
    let output = css::compile(
        &Options {
            styles: &definition.styles,
            vars: Some(&scopes),
            ..Options::default()
        },
        None,
    )
    .expect("compiled");

    insta::assert_snapshot!(classes(&output), @"text: z_0 z_1 z_2");
    insta::assert_snapshot!(format!("{:?}", output.vars), @r#"{"brand": "z-theme-brand-brand"}"#);
    insta::assert_snapshot!(output.css, @"
    :where(*){--z-brand-color-ink-fallback-1ghx29b15thjhz:black;}
    @media (prefers-contrast: more){:where(*){--z-brand-color-ink-fallback-1ghx29b15thjhz:#000;}}
    .z-theme-brand-brand{--z-brand-color-ink:var(--z-brand-color-ink-fallback-1ghx29b15thjhz);--z-brand-color-accent:light-dark(#06c,#9cf);}
    @media (prefers-contrast: more){.z-theme-brand-brand{--z-brand-color-ink:#000;}}
    .z_0{color:var(--z-brand-color-ink,var(--z-brand-color-ink-fallback-1ghx29b15thjhz));}
    .z_1{border-color:var(--z-brand-color-accent,light-dark(#06c,#9cf));}
    .z_2{border-style:solid;}
    ");

    let shared = css::compile(
        &Options {
            shared: Some(Shared::Defaults),
            styles: &definition.styles,
            vars: Some(&scopes),
            ..Options::default()
        },
        None,
    )
    .expect("compiled");

    insta::assert_snapshot!(
        shared
            .shared
            .unwrap_or_default()
            .iter()
            .map(|resource| format!("{}\n{}", resource.id, resource.css))
            .collect::<Vec<_>>()
            .join("\n"),
        @"
    --z-brand-color-ink-fallback-1ghx29b15thjhz
    :where(*){--z-brand-color-ink-fallback-1ghx29b15thjhz:black;}
    @media (prefers-contrast: more){:where(*){--z-brand-color-ink-fallback-1ghx29b15thjhz:#000;}}
    "
    );
}

#[test]
fn compile_orders_contributions_and_layers() {
    let rule = define(serde_json::json!({ "body": { "margin": 0 } }));
    let contributions = [
        Definition {
            kind: Kind::Layers {
                names: vec!["base".into(), "components".into()],
            },
            within: Vec::new(),
        },
        Definition {
            kind: Kind::Rule {
                selector: "body".into(),
                style: Arc::clone(&rule.styles[0]),
            },
            within: vec!["@layer base".into()],
        },
        Definition {
            kind: Kind::Import {
                layer: Some(ImportLayer::Named("reset".into())),
                media: None,
                supports: None,
                url: "/reset.css".into(),
            },
            within: Vec::new(),
        },
    ];
    let output = css::compile(
        &Options {
            contributions: &contributions,
            ..Options::default()
        },
        None,
    )
    .expect("compiled");

    insta::assert_snapshot!(output.contribution_css.unwrap_or_default(), @r#"
    @layer base,components;
    @import url("/reset.css") layer(reset);
    @layer base{body{margin:0;}}
    "#);

    let conflicting = [
        Definition {
            kind: Kind::Layers {
                names: vec!["a".into(), "b".into()],
            },
            within: Vec::new(),
        },
        Definition {
            kind: Kind::Layers {
                names: vec!["b".into(), "a".into()],
            },
            within: Vec::new(),
        },
    ];

    insta::assert_snapshot!(
        message(&
            css::compile(
                &Options {
                    contributions: &conflicting,
                    ..Options::default()
                },
                None,
            )
            .expect_err("conflicting layers")
        ),
        @r#"["contributions"]: Conflicting layer order constraints."#
    );
}

#[test]
fn compile_reports_names_and_explicit_identity_collisions() {
    let definition = define(serde_json::json!({
        "first": { "color": "red" },
        "second": { "color": "blue" },
    }));
    let names: Names = [
        (Arc::from("first"), Arc::from("shared-id")),
        (Arc::from("second"), Arc::from("shared-id")),
    ]
    .into_iter()
    .collect();
    let error = css::compile(
        &Options {
            names: Some(&names),
            styles: &definition.styles,
            ..Options::default()
        },
        None,
    )
    .expect_err("collision");

    insta::assert_snapshot!(message(&error), @r#"["second"]: An explicit id is used for different styles."#);

    let duplicated = [
        Arc::clone(&definition.styles[0]),
        Arc::clone(&definition.styles[0]),
    ];
    let error = css::compile(
        &Options {
            styles: &duplicated,
            ..Options::default()
        },
        None,
    )
    .expect_err("duplicate");

    insta::assert_snapshot!(message(&error), @r#"["first"]: Style names must be nonempty and unique."#);
}

#[test]
fn compile_round_trips_the_wire_format() {
    // `color` refers to object 1 (flags 4) and `padding` is an important number (flags 3).
    let input = r#"{"objects":[["c",{"keys":["variableSet"],"variableSet":true}],["t",0,"color","color.ink","red",false],["m",0,null,[["color.ink","green"]],null,null]],"strings":["color","padding"],"styles":[{"d":[0,1,4,1,8,3],"n":"0"},{"d":[],"n":"card","o":"grouped"}],"vars":[["first",2]]}"#;

    insta::assert_snapshot!(wire::compile(input), @r#"{"classes":{"0":"z_0 z_1","card":""},"css":".z0{--z0:green;}\n.z_0{color:var(--z0,red);}\n.z_1{padding:8!important;}","vars":{"first":"z0"},"rules":{"z_0":"color:var(--z0,red);","z_1":"padding:8!important;","@scope:z0:_2d__2d_z0:_5b__5d_":"green"},"units":[["\u0001z-text-[var(--z0,red)]",false,"z_0"],["\u0001z-p-[8!important]",false,"z_1"]]}"#);
    insta::assert_snapshot!(
        wire::compile(r#"{"styles":[{"d":[],"n":"card","o":"inline"}]}"#),
        @r#"{"error":{"name":"Css.CompileError","message":"[\"card\",\"cssOutput\"]: cssOutput must be atomic or grouped.","diagnostics":[{"code":"invalid_output","message":"cssOutput must be atomic or grouped.","path":["card","cssOutput"]}]}}"#
    );
    insta::assert_snapshot!(wire::compile(r#"{"styles":[{"n":1}]}"#), @r#"{"error":{"name":"Error","message":"Invalid compiler wire input: invalid type: integer `1`, expected a string at line 1 column 17"}}"#);
}

#[test]
fn style_names_content_with_tokens_and_targets() {
    let definition = define(serde_json::json!({
        "card": { "color": "red", "@media (min-width: 1px)": { "padding": 1 } },
        "native": { "color": "red", "targets": { "native": { "elevation": 2 }, "web": { "cursor": "pointer" } } },
    }));

    insta::assert_snapshot!(identity::style(&definition.styles[0], None), @"z-content-_5b__5b__22__22__2c__5b__5b__22_color_22__2c__22_red_22__2c_false_5d__5d__5d__2c__5b__22__40_media_20__28_min_2d_width_3a__20_1px_29__22__2c__5b__5b__22_padding_22__2c_1_2c_false_5d__5d__5d__5d_");
    insta::assert_snapshot!(identity::style(&definition.styles[1], Some("app")), @"z-app-content-_5b__5b__5b__22_color_22__2c__22_red_22__2c_false_5d__5d__2c__7b__22_elevation_22__3a_2_7d__2c_null_2c_null_2c__5b__5b__22_cursor_22__2c__22_pointer_22__2c_false_5d__5d__5d_");
}

#[test]
fn shorthands_validate_and_sign_alias_records() {
    let value = data(
        serde_json::json!({ "px": ["paddingLeft", "paddingRight"], "bg": ["backgroundColor"] }),
    );

    insta::assert_snapshot!(shorthands::signature(&value).expect("signature"), @r#"[["bg",["backgroundColor"]],["px",["paddingLeft","paddingRight"]]]"#);
    insta::assert_snapshot!(
        message(&shorthands::read(&data(serde_json::json!({ "color": ["fill"] }))).expect_err("reserved")),
        @"Invalid shorthand name: color"
    );
    insta::assert_snapshot!(
        message(&shorthands::read(&data(serde_json::json!({ "px": ["paddingLeft", "paddingLeft"] }))).expect_err("duplicate")),
        @"Shorthand px requires unique standard properties."
    );
}
