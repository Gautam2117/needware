use needware_capabilities::Grants;
use needware_crypto::SecretKey;
use needware_ir::{Component, Expr, Value, visuals_example};
use needware_package::Asset;
use needware_runtime::{Event, Runtime, ViewNode};
use std::collections::BTreeMap;
type Result = std::result::Result<(), Box<dyn std::error::Error>>;
fn load(
    mut app: needware_ir::Application,
    assets: bool,
) -> std::result::Result<Runtime, Box<dyn std::error::Error>> {
    app.id = "ca89e52d-f930-491c-8f36-fbc7a0a2eea0".into();
    let key = SecretKey::from_bytes([13; 32]);
    let assets = if assets {
        vec![Asset {
            media_type: "image/png".into(),
            bytes: include_bytes!("../../../tests/fixtures/raster.png").to_vec(),
        }]
    } else {
        vec![]
    };
    let bytes = needware_package::build(app.clone(), assets, &key)?;
    Ok(Runtime::load(
        needware_package::verify(&bytes)?,
        None,
        Grants {
            application: app.id,
            revision: app.revision,
            capabilities: app.capabilities,
        },
        &[key.public_key()],
    )?)
}
fn app() -> needware_ir::Application {
    visuals_example::application(&hex::encode(needware_crypto::digest(include_bytes!(
        "../../../tests/fixtures/raster.png"
    ))))
}
fn find(node: &ViewNode, kind: Component) -> Option<&ViewNode> {
    if node.kind == kind {
        Some(node)
    } else {
        node.children
            .iter()
            .find_map(|child| find(child, kind.clone()))
    }
}
#[test]
fn verified_assets_and_typed_visuals_project_without_external_urls() -> Result {
    let runtime = load(app(), true)?;
    let view = runtime.view()?;
    assert!(view.theme.is_some());
    let raster = find(&view, Component::Image)
        .ok_or("image")?
        .raster
        .as_ref()
        .ok_or("raster")?;
    assert_eq!(raster.media_type, "image/png");
    assert_eq!(
        hex::decode(&raster.bytes_hex)?,
        include_bytes!("../../../tests/fixtures/raster.png")
    );
    assert!(
        find(&view, Component::Chart)
            .ok_or("chart")?
            .value
            .is_some()
    );
    assert!(
        find(&view, Component::Calendar)
            .ok_or("calendar")?
            .value
            .is_some()
    );
    assert!(load(app(), false)?.view().is_err());
    let mut external = app();
    let image = &mut external.screens[0].root.children[1].children[1].children[1];
    image.value = Some(Expr::Literal {
        value: Value::String("https://example.invalid/image.png".into()),
    });
    assert!(load(external, true)?.view().is_err());
    Ok(())
}
#[test]
fn malformed_charts_calendar_and_assets_preserve_the_transaction_cut() -> Result {
    let mut runtime = load(app(), true)?;
    let before = runtime.state().clone();
    let event = Event {
        action: "invalid_chart".into(),
        values: BTreeMap::new(),
        now: "2026-10-05T00:00:00Z".into(),
        timezone: "UTC".into(),
    };
    assert!(runtime.dispatch(&event).is_err());
    assert_eq!(*runtime.state(), before);
    let mut broken = before.clone();
    if let Some(Value::List(points)) = broken.values.get_mut("chart")
        && let Some(Value::Map(point)) = points.first_mut()
    {
        point.insert("label".into(), Value::String(String::new()));
    }
    assert!(runtime.restore(broken).is_err());
    assert_eq!(*runtime.state(), before);
    let mut calendar = app();
    if let Some(Value::Map(fields)) = calendar.state.get_mut("calendar") {
        fields.insert("month".into(), Value::Date("2026-10-02".into()));
    }
    assert!(load(calendar, true)?.view().is_err());
    let mut limit = app();
    let raster = limit.screens[0].root.children[1].children[1].children[1].clone();
    limit.screens[0].root.children[1].children[1]
        .children
        .extend((0..4096).map(|index| {
            let mut node = raster.clone();
            node.id = format!("raster_{index}");
            node
        }));
    assert!(needware_validation::validate(limit).is_err());
    Ok(())
}
#[test]
fn unknown_features_icons_headers_and_tab_labels_reject_before_activation() -> Result {
    let mut missing = app();
    missing
        .runtime_features
        .retain(|feature| feature != "visual_components_v1");
    assert!(needware_validation::validate(missing).is_err());
    let mut tabs = app();
    tabs.screens[0].root.children[1].options[1] = "Profile".into();
    assert!(needware_validation::validate(tabs).is_err());
    let mut icon = app();
    icon.screens[0].root.children[1].children[1].children[0].options[0] = "external_svg".into();
    assert!(needware_validation::validate(icon).is_err());
    let mut table = app();
    table.screens[0].root.children[1].children[1]
        .children
        .last_mut()
        .ok_or("table")?
        .options
        .clear();
    assert!(needware_validation::validate(table).is_err());
    Ok(())
}
#[test]
fn compressed_images_cannot_exceed_the_aggregate_decode_budget() -> Result {
    let bytes = include_bytes!("../../../tests/fixtures/large-raster.png");
    let digest = hex::encode(needware_crypto::digest(bytes));
    let mut app = visuals_example::application(&digest);
    let image = app.screens[0].root.children[1].children[1].children[1].clone();
    app.screens[0].root.children = (0..5)
        .map(|index| {
            let mut image = image.clone();
            image.id = format!("bounded_image_{index}");
            image
        })
        .collect();
    let key = SecretKey::from_bytes([13; 32]);
    let package = needware_package::build(
        app.clone(),
        vec![Asset {
            media_type: "image/png".into(),
            bytes: bytes.to_vec(),
        }],
        &key,
    )?;
    let runtime = Runtime::load(
        needware_package::verify(&package)?,
        None,
        Grants {
            application: app.id,
            revision: app.revision,
            capabilities: app.capabilities,
        },
        &[key.public_key()],
    )?;
    assert!(matches!(
        runtime.view(),
        Err(needware_runtime::RuntimeError::Limit)
    ));
    Ok(())
}
