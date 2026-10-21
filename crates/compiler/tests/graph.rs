//! Compiles source graphs through the JSON operations the host adapters call.

use compiler::api;

mod compile {
    use super::api;

    #[test]
    fn base_ui_linked_configuration() {
        let input = serde_json::json!({
            "imports": {
                "config.ts": {"zyzz/base-ui/react": null},
                "select.ts": {"./config.js": "config.ts", "@base-ui/react/select": null}
            },
            "modules": {
                "config.ts": "import {defineConfig} from 'zyzz/base-ui/react';export const {style,vars}=defineConfig({vars:{color:{brand:'red'}}});",
                "select.ts": "import {style,vars} from './config.js';import {Select} from '@base-ui/react/select';export const item=style(Select.Item,{states:{highlighted:{color:vars.color.brand}}});"
            }
        });
        let output: serde_json::Value =
            serde_json::from_str(&api::call("graph.compile", &input.to_string())).unwrap();

        insta::assert_snapshot!(output["error"], @"null");
        insta::assert_snapshot!(output["modules"]["select.ts"]["css"].as_str().unwrap_or_default(), @"
        .z-theme-theme{--z-color-brand:red;}
        .z_scheme-dark{color-scheme:dark;}
        .z_scheme-light{color-scheme:light;}
        .z_scheme-light-dark{color-scheme:light dark;}
        .z_PAxzm40{&[data-highlighted]{color:var(--z-color-brand,red);}}
        ");

        let packed = serde_json::json!({
            "contracts": {"config.ts": output["contracts"]["config.ts"]},
            "imports": input["imports"],
            "modules": {"select.ts": input["modules"]["select.ts"]}
        });
        let output: serde_json::Value =
            serde_json::from_str(&api::call("graph.compile", &packed.to_string())).unwrap();

        insta::assert_snapshot!(output["error"], @"null");
        insta::assert_snapshot!(output["modules"]["select.ts"]["css"].as_str().unwrap_or_default(), @"
        .z-theme-theme{--z-color-brand:red;}
        .z_PAxzm40{&[data-highlighted]{color:var(--z-color-brand,red);}}
        ");
    }

    #[test]
    fn references_keep_interpolated_identities() {
        let input = |references: bool| {
            serde_json::json!({
                "imports": {
                    "card.ts": {"zyzz": null},
                    "page.ts": {"zyzz": null, "./card.js": "card.ts"}
                },
                "modules": {
                    "card.ts": "import {style} from 'zyzz';export const card=style({color:'red'});export const label=style({color:'blue'});",
                    "page.ts": "import {style} from 'zyzz';import {card,label} from './card.js';export const title=style({selectors:{[`${card}:hover &`]:{color:'green'}}});export const page=()=>[card(),label(),title()];"
                },
                "references": references
            })
            .to_string()
        };
        let classes = |output: &str| {
            let output: serde_json::Value = serde_json::from_str(output).unwrap();

            output["modules"]["card.ts"]["code"]
                .as_str()
                .unwrap_or_default()
                .to_owned()
        };

        insta::assert_snapshot!(classes(&api::call("graph.compile", &input(false))), @r#"

        import { Props as __zyzzProps } from 'zyzz/runtime';
        export const card=/*#__PURE__*/__zyzzProps.create({className:"z_bgXhTU0 z-style-bgXhTU-card"});export const label=/*#__PURE__*/__zyzzProps.create({className:"z_bgXhTU1 z-style-bgXhTU-label"});
        "#);
        insta::assert_snapshot!(classes(&api::call("graph.compile", &input(true))), @r#"

        import { Props as __zyzzProps } from 'zyzz/runtime';
        export const card=/*#__PURE__*/__zyzzProps.create({className:"z_bgXhTU0 z-style-bgXhTU-card"});export const label=/*#__PURE__*/__zyzzProps.create({className:"z_bgXhTU1"});
        "#);
    }

    #[test]
    fn empty_graph() {
        insta::assert_snapshot!(
            api::call("graph.compile", r#"{"modules":{}}"#),
            @r#"{"contracts":{},"dependencies":{},"modules":{}}"#
        );
    }

    #[test]
    fn conflicting_sources() {
        insta::assert_snapshot!(
            api::call(
                "graph.compile",
                r#"{"contracts":{"a.ts":"{}"},"modules":{"a.ts":""}}"#
            ),
            @r#"{"error":{"name":"Source.ExtractError","diagnostics":[{"code":"unsupported_syntax","end":0,"message":"A module cannot supply both source and a library contract.","source":"a.ts","start":0}],"message":"a.ts:0: A module cannot supply both source and a library contract."}}"#
        );
    }

    #[test]
    fn malformed_contracts() {
        insta::assert_snapshot!(
            api::call("graph.compile", r#"{"contracts":{"lib":"{"},"modules":{}}"#),
            @r#"{"error":{"name":"Source.ExtractError","diagnostics":[{"code":"unsupported_syntax","end":0,"message":"Invalid library contract: Expected property name or '}' in JSON at position 1 (line 1 column 2)","source":"lib","start":0}],"message":"lib:0: Invalid library contract: Expected property name or '}' in JSON at position 1 (line 1 column 2)"}}"#
        );
    }

    #[test]
    fn invalid_contracts() {
        insta::assert_snapshot!(
            api::call("graph.compile", r#"{"contracts":{"lib":"{}"},"modules":{}}"#),
            @r#"{"error":{"name":"Source.ExtractError","diagnostics":[{"code":"unsupported_syntax","end":0,"message":"Invalid library contract: Unsupported Zyzz contract version.","source":"lib","start":0}],"message":"lib:0: Invalid library contract: Unsupported Zyzz contract version."}}"#
        );
    }
}

mod create {
    use compiler::compiler::handles::Compiler;

    #[test]
    fn unchanged_snapshots() {
        let mut compiler = Compiler::default();
        let input = r#"{"modules":{}}"#;

        insta::assert_snapshot!(
            compiler.compile(input),
            @r#"{"contracts":{},"dependencies":{},"modules":{}}"#
        );
        insta::assert_snapshot!(compiler.compile(input), @r#"{"same":true}"#);
    }

    #[test]
    fn repeated_failures() {
        let mut compiler = Compiler::default();
        let valid = r#"{"modules":{}}"#;
        let invalid = r#"{"contracts":{"lib":"{}"},"modules":{}}"#;

        compiler.compile(valid);

        // A failing snapshot reports its error again rather than the earlier success.
        insta::assert_snapshot!(
            compiler.compile(invalid),
            @r#"{"error":{"name":"Source.ExtractError","diagnostics":[{"code":"unsupported_syntax","end":0,"message":"Invalid library contract: Unsupported Zyzz contract version.","source":"lib","start":0}],"message":"lib:0: Invalid library contract: Unsupported Zyzz contract version."}}"#
        );
        insta::assert_snapshot!(
            compiler.compile(invalid),
            @r#"{"error":{"name":"Source.ExtractError","diagnostics":[{"code":"unsupported_syntax","end":0,"message":"Invalid library contract: Unsupported Zyzz contract version.","source":"lib","start":0}],"message":"lib:0: Invalid library contract: Unsupported Zyzz contract version."}}"#
        );
        insta::assert_snapshot!(compiler.compile(valid), @r#"{"same":true}"#);
    }

    #[test]
    fn alternating_snapshots() {
        let mut compiler = Compiler::default();
        let button =
            r#""button.ts":"import {style} from 'zyzz';export const button=style({color:'red'});""#;
        let card =
            r#""card.ts":"import {style} from 'zyzz';export const card=style({opacity:0.5});""#;
        let mut compile = |modules: &str| -> serde_json::Value {
            // Host-resolved imports keep the cache while modules enter and leave the graph.
            serde_json::from_str(
                &compiler.compile(&format!(
                    r#"{{"imports":{{"button.ts":{{"zyzz":null}},"card.ts":{{"zyzz":null}}}},"modules":{{{modules}}}}}"#
                )),
            )
            .unwrap_or_default()
        };
        let both = format!("{button},{card}");

        assert!(compile(&both)["modules"]["card.ts"].is_object());
        insta::assert_snapshot!(compile(button)["modules"]["button.ts"].to_string(), @"0");

        // The card output is the one the host decoded before the snapshot without it.
        insta::assert_snapshot!(compile(&both)["modules"]["card.ts"].to_string(), @"0");
    }

    fn json(text: &str) -> String {
        serde_json::to_string(text).unwrap_or_default()
    }

    /// A graph whose page imports a module that exports only a function. A `None` source
    /// crosses the boundary as `0`.
    fn component(button: Option<&str>, page: bool) -> String {
        let button = button.map_or_else(
            || "0".to_owned(),
            |color| {
                json(&format!(
                    "import {{style}} from 'zyzz';const button=style({{color:'{color}'}});export function Button(){{return button()}}"
                ))
            },
        );
        let page = if page {
            json(
                "import {Button} from './button.js';import {style} from 'zyzz';export const page=style({opacity:0.5});export const element=Button();",
            )
        } else {
            "0".to_owned()
        };

        format!(
            r#"{{"imports":{{"button.ts":{{"zyzz":null}},"page.ts":{{"./button.js":"button.ts","zyzz":null}}}},"modules":{{"button.ts":{button},"page.ts":{page}}}}}"#
        )
    }

    #[test]
    fn function_exports() {
        let mut compiler = Compiler::default();

        compiler.compile(&component(Some("red"), true));

        let edited: serde_json::Value =
            serde_json::from_str(&compiler.compile(&component(Some("blue"), true)))
                .unwrap_or_default();
        let fresh: serde_json::Value =
            serde_json::from_str(&Compiler::default().compile(&component(Some("blue"), true)))
                .unwrap_or_default();

        // The importer reads nothing from a module that exports only functions, so it keeps its
        // result across that module's edits.
        insta::assert_snapshot!(edited["modules"]["page.ts"].to_string(), @"0");
        insta::assert_snapshot!(
            (edited["modules"]["button.ts"] == fresh["modules"]["button.ts"]).to_string(),
            @"true"
        );
    }

    #[test]
    fn unchanged_sources() {
        let mut compiler = Compiler::default();

        compiler.compile(&component(Some("red"), true));

        // `0` names the source the previous snapshot held.
        insta::assert_snapshot!(compiler.compile(&component(None, false)), @r#"{"same":true}"#);

        let edited: serde_json::Value =
            serde_json::from_str(&compiler.compile(&component(Some("blue"), false)))
                .unwrap_or_default();
        let fresh: serde_json::Value =
            serde_json::from_str(&Compiler::default().compile(&component(Some("blue"), true)))
                .unwrap_or_default();

        insta::assert_snapshot!(
            (edited["modules"]["button.ts"] == fresh["modules"]["button.ts"]).to_string(),
            @"true"
        );

        // A compiler without the named source asks for the complete snapshot.
        insta::assert_snapshot!(
            Compiler::default().compile(&component(None, true)),
            @r#"{"stale":true}"#
        );
    }
}

mod transform {
    use super::api;

    #[test]
    fn base_ui_ordinary_styles() {
        for entrypoint in ["zyzz", "zyzz/base-ui/react"] {
            let input = serde_json::json!({
                "moduleId": "select.ts",
                "source": format!("import {{style}} from '{entrypoint}';const body={{color:'red'}};export const item=style(body,{{id:'item'}});")
            });
            let (output, _) = compile(&input.to_string());

            insta::allow_duplicates! {
                insta::assert_snapshot!(output["error"], @"null");
                insta::assert_snapshot!(output["css"].as_str().unwrap_or_default(), @".z_PAxzm40{color:red;}");
            }
        }

        let input = serde_json::json!({
            "moduleId": "select.ts",
            "source": "import {style} from 'zyzz';import {Select} from '@base-ui/react/select';export const item=style(Select.Item,{states:{highlighted:{color:'red'}}});"
        });
        let (output, _) = compile(&input.to_string());

        insta::assert_snapshot!(output["error"].is_object(), @"true");
    }

    #[test]
    fn base_ui_selector_interpolation() {
        let input = serde_json::json!({
            "moduleId": "select.ts",
            "source": "import {style} from 'zyzz/base-ui/react';import {Select} from '@base-ui/react/select';const parent=style({}, {id:'parent'});export const item=style(Select.Item,{selectors:{[`${parent}:hover &`]:{states:{highlighted:{color:'red'}}}}},{id:'item'});"
        });
        let (output, _) = compile(&input.to_string());

        insta::assert_snapshot!(output["error"], @"null");
        insta::assert_snapshot!(output["css"].as_str().unwrap_or_default(), @".z_PAxzm40{.z-style-id-parent:hover &{&[data-highlighted]{color:red;}}}");
    }

    #[test]
    fn base_ui_states() {
        let input = serde_json::json!({
            "moduleId": "select.ts",
            "source": "import {style} from 'zyzz/base-ui/react';import {Select} from '@base-ui/react/select';export const item=style(Select.Item,{states:{highlighted:{color:'red'}},selectors:{'&[data-highlighted]':{color:'blue'}},'&[data-highlighted]':{color:'green',states:{disabled:{opacity:0.5}}}},{id:'item'});export const popup=style(Select.Popup,{states:{side:{bottom:{color:'red'}}}});"
        });

        let (output, _) = compile(&input.to_string());

        insta::assert_snapshot!(output["css"].as_str().unwrap_or_default(), @r#"
        .z_PAxzm40{&[data-highlighted]{color:red;}}
        .z_PAxzm41{&[data-highlighted]/*base-ui-1*/{color:blue;}}
        .z_PAxzm42{&[data-highlighted]/*base-ui-2*/{color:green;}}
        .z_PAxzm43{&[data-highlighted]/*base-ui-2*/{&[data-disabled]{opacity:0.5;}}}
        .z_PAxzm44{&[data-side="bottom"]{color:red;}}
        "#);
        insta::assert_snapshot!(output["error"], @"null");
        insta::assert_snapshot!(output["code"].as_str().unwrap_or_default().contains("zyzz/base-ui/react"), @"false");
    }

    #[test]
    fn base_ui_import_forms() {
        for imports in [
            "import {Select as S} from '@base-ui/react';",
            "import * as S from '@base-ui/react/select';",
        ] {
            let input = serde_json::json!({
                "moduleId": "select.ts",
                "source": format!("import {{style}} from 'zyzz/base-ui/react';{imports}export const item=style(S{} ,{{states:{{highlighted:{{color:'red'}}}}}});", if imports.contains("* as") { ".Select.Item" } else { ".Item" })
            });
            let (output, _) = compile(&input.to_string());

            insta::allow_duplicates! {
                insta::assert_snapshot!(output["error"], @"null");
                insta::assert_snapshot!(output["css"].as_str().unwrap_or_default(), @".z_PAxzm40{&[data-highlighted]{color:red;}}");
            }
        }

        let input = serde_json::json!({
            "moduleId": "button.ts",
            "source": "import {style} from 'zyzz/base-ui/react';import {Button} from '@base-ui/react/button';export const button=style(Button,{states:{disabled:{color:'red'}}},{id:'button'});"
        });
        let (output, _) = compile(&input.to_string());

        insta::assert_snapshot!(output["error"], @"null");
        insta::assert_snapshot!(output["css"].as_str().unwrap_or_default(), @".z_zaclPW0{&[data-disabled]{color:red;}}");
    }

    #[test]
    fn base_ui_diagnostics() {
        let mut diagnostics = Vec::new();

        for body in [
            "style(Select.Item,{states:{unknown:{color:'red'}}})",
            "style(Select.Popup,{states:{side:{unknown:{color:'red'}}}})",
            "style(wrap(Select.Item),{color:'red'})",
            "style(Local,{color:'red'})",
            "style(Select.Item,()=>({color:'red'}))",
        ] {
            let input = serde_json::json!({
                "moduleId": "select.ts",
                "source": format!("import {{style}} from 'zyzz/base-ui/react';import {{Select}} from '@base-ui/react/select';const Local=()=>null;export const item={body};")
            });
            let (output, _) = compile(&input.to_string());

            diagnostics.push(output["error"]["diagnostics"][0]["message"].clone());
        }

        insta::assert_snapshot!(serde_json::to_string_pretty(&diagnostics).unwrap(), @r#"
        [
          "Unknown Base UI state: unknown.",
          "Unknown Base UI state value: side.unknown.",
          "Base UI components must resolve to imports from @base-ui/react.",
          "Definition options require one nonempty literal id.",
          "Base UI component styles require static object bodies."
        ]
        "#);
    }

    #[test]
    fn base_ui_configuration() {
        let input = serde_json::json!({
            "moduleId": "select.ts",
            "source": "import {defineConfig} from 'zyzz/base-ui/react';import {Select} from '@base-ui/react/select';const {style,vars}=defineConfig({vars:{color:{brand:'red'}}});export const item=style(Select.Item,{states:{highlighted:{color:vars.color.brand}}});"
        });
        let (output, _) = compile(&input.to_string());

        insta::assert_snapshot!(output["error"], @"null");
        insta::assert_snapshot!(output["css"].as_str().unwrap_or_default(), @"
        .z-theme-theme{--z-color-brand:red;}
        .z_scheme-dark{color-scheme:dark;}
        .z_scheme-light{color-scheme:light;}
        .z_scheme-light-dark{color-scheme:light dark;}
        .z_PAxzm40{&[data-highlighted]{color:var(--z-color-brand,red);}}
        ");
    }

    /// A `transform.compile` result's module and the records that follow it after a NUL.
    fn compile(input: &str) -> (serde_json::Value, String) {
        let output = api::call("transform.compile", input);
        let (module, records) = output.split_once('\0').unwrap_or((&output, ""));

        (
            serde_json::from_str(module).unwrap_or_default(),
            records.to_owned(),
        )
    }

    #[test]
    fn invalid_output_modes() {
        insta::assert_snapshot!(
            api::call(
                "transform.compile",
                r#"{"cssOutput":"nested","moduleId":"card.ts","source":"import {style} from 'zyzz';export const card=style({color:'red'});"}"#,
            ),
            @r#"{"error":{"name":"Css.CompileError","diagnostics":[{"code":"invalid_output","message":"cssOutput must be atomic or grouped.","path":["cssOutput"]}],"message":"[\"cssOutput\"]: cssOutput must be atomic or grouped."}}"#
        );

        let (output, _) = compile(
            r#"{"composition":"mixed","moduleId":"card.ts","source":"import {style} from 'zyzz';export const card=style({color:'red'});"}"#,
        );

        insta::assert_snapshot!(output["css"].as_str().unwrap_or_default(), @".z_bgXhTU0{color:red;}");
    }

    #[test]
    fn separate_sources() {
        let (output, records) = compile(
            "{\"moduleId\":\"card.ts\"}\0import {style} from 'zyzz';export const card=style({color:'red'});",
        );

        insta::assert_snapshot!(output["css"].as_str().unwrap_or_default(), @".z_bgXhTU0{color:red;}");
        insta::assert_snapshot!(output["map"]["sourcesContent"], @"[0]");
        insta::assert_snapshot!(output["cssMap"]["sourcesContent"], @"[0]");
        insta::assert_snapshot!(records, @r#"{"classes":{"style-1slxe42dbli7u-45":"z_bgXhTU0 z-style-bgXhTU-card"},"rules":{"z_bgXhTU0":"color:red;"},"units":[["\u0001z-bgXhTU-text-red",false,"z_bgXhTU0"]]}"#);
    }

    #[test]
    fn variable_slots() {
        let (output, _) = compile(
            r#"{"moduleId":"library.ts","source":"import {variable} from 'zyzz';export const gap=variable('length');"}"#,
        );

        insta::assert_snapshot!(output["code"].as_str().unwrap_or_default(), @r#"

        import { Variable as __zyzzVariable } from 'zyzz/runtime';
        export const gap=__zyzzVariable.create({"name":"--z-gap","type":"length","variable":true});
        "#);
    }
}

mod repack {
    use super::api;

    #[test]
    fn dependency_chains() {
        let output: serde_json::Value = serde_json::from_str(&api::call(
            "graph.compile",
            r#"{"modules":{"wrapper/index.ts":"import 'dep';export const loaded=true;"},"contracts":{"dep/index.js":"{\"stylesheets\":[{\"source\":\"index.ts\",\"namespaces\":[],\"key\":\"0\",\"css\":\"body{background-image:url(./pixel.svg);}\",\"layers\":[],\"start\":32,\"content\":\"import {global} from 'zyzz/web';global({body:{backgroundImage:'url(./pixel.svg)'}});\"}],\"exports\":{},\"themes\":{},\"version\":31}"},"imports":{"wrapper/index.ts":{"dep":"dep/index.js"}}}"#,
        ))
        .unwrap_or_default();

        insta::assert_snapshot!(
            output["contracts"]["wrapper/index.ts"].as_str().unwrap_or_default(),
            @r#"{"literals":{"loaded":"true"},"stylesheets":[{"source":"index.ts","namespaces":[],"key":"0","css":"body{background-image:url(./pixel.svg);}","layers":[],"start":32,"dependency":["dep"],"content":"import {global} from 'zyzz/web';global({body:{backgroundImage:'url(./pixel.svg)'}});"}],"exports":{},"themes":{},"version":35}"#
        );
    }
}

mod dependencies {
    use super::api;

    #[test]
    fn repacked_sections() {
        insta::assert_snapshot!(
            api::call(
                "contract.dependencies",
                r#"{"moduleId":"lib/index.js","contract":"{\"stylesheets\":[{\"source\":\"a.ts\",\"dependency\":[\"dep\"],\"css\":\"\",\"layers\":[]},{\"source\":\"b.ts\",\"css\":\"\",\"layers\":[]}],\"exports\":{},\"themes\":{},\"version\":31}"}"#,
            ),
            @r#"{"dependencies":[["dep"],[]]}"#
        );
    }

    #[test]
    fn malformed_contracts() {
        insta::assert_snapshot!(
            api::call("contract.dependencies", r#"{"moduleId":"lib","contract":"{"}"#),
            @r#"{"error":{"name":"SyntaxError","message":"Expected property name or '}' in JSON at position 1 (line 1 column 2)"}}"#
        );
    }

    #[test]
    fn invalid_contracts() {
        insta::assert_snapshot!(
            api::call("contract.dependencies", r#"{"moduleId":"lib","contract":"{}"}"#),
            @r#"{"error":{"name":"Error","message":"Unsupported Zyzz contract version."}}"#
        );
    }
}
