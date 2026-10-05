use super::*;
use examples::{node, text};
fn field(data_type: DataType) -> Field {
    Field {
        data_type,
        default: None,
        max_length: None,
        minimum: None,
        maximum: None,
        derived: None,
    }
}
fn point(label: &str, value: &str) -> Value {
    Value::Map(BTreeMap::from([
        ("label".into(), Value::String(label.into())),
        ("value".into(), Value::Integer(value.into())),
    ]))
}
pub fn application(asset: &str) -> Application {
    let mut app = widgets_example::application();
    app.title = "Visual components fixture".into();
    app.runtime_features.push("visual_components_v1".into());
    app.theme.accent = Accent::Indigo;
    app.theme.density = Density::Compact;
    let points = Value::List(vec![
        point("Exact large", "9007199254740993"),
        point("Negative", "-20"),
        point("Zero", "0"),
    ]);
    app.state.insert("chart".into(), points);
    app.state_schema.insert(
        "chart".into(),
        field(DataType::List {
            item: Box::new(DataType::Record {
                fields: BTreeMap::from([
                    ("label".into(), field(DataType::String)),
                    ("value".into(), field(DataType::Integer)),
                ]),
            }),
        }),
    );
    let events = Value::List(vec![Value::Map(BTreeMap::from([
        ("date".into(), Value::Date("2026-10-05".into())),
        ("label".into(), Value::String("Review budget".into())),
    ]))]);
    app.state.insert(
        "calendar".into(),
        Value::Map(BTreeMap::from([
            ("month".into(), Value::Date("2026-10-01".into())),
            ("events".into(), events),
        ])),
    );
    let event_fields = BTreeMap::from([
        ("date".into(), field(DataType::Date)),
        ("label".into(), field(DataType::String)),
    ]);
    let event_list = field(DataType::List {
        item: Box::new(DataType::Record {
            fields: event_fields,
        }),
    });
    let calendar_fields = BTreeMap::from([
        ("month".into(), field(DataType::Date)),
        ("events".into(), event_list),
    ]);
    app.state_schema.insert(
        "calendar".into(),
        field(DataType::Record {
            fields: calendar_fields,
        }),
    );
    let mut chart = node(
        "visual_chart",
        Component::Chart,
        Some(text("Signed totals")),
        vec![],
    );
    chart.value = Some(Expr::State {
        key: "chart".into(),
    });
    let mut calendar = node(
        "visual_calendar",
        Component::Calendar,
        Some(text("October plans")),
        vec![],
    );
    calendar.value = Some(Expr::State {
        key: "calendar".into(),
    });
    let mut image = node(
        "visual_image",
        Component::Image,
        Some(text("Verified checker sample")),
        vec![],
    );
    image.value = Some(text(asset));
    let mut icon = node(
        "visual_icon",
        Component::Icon,
        Some(text("Verified sample")),
        vec![],
    );
    icon.options = vec!["check".into()];
    let mut input = node(
        "visual_record_input",
        Component::TextInput,
        Some(text("Record name")),
        vec![],
    );
    input.field = Some("name".into());
    let mut add = node(
        "visual_record_form",
        Component::Form,
        Some(text("Add record")),
        vec![input],
    );
    add.action = Some("add".into());
    let mut status = node(
        "visual_record_toggle",
        Component::Button,
        Some(Expr::If {
            condition: Box::new(Expr::Item {
                field: "done".into(),
            }),
            yes: Box::new(text("Undo")),
            no: Box::new(text("Complete")),
        }),
        vec![],
    );
    status.action = Some("toggle".into());
    let mut table = node(
        "visual_table",
        Component::Table,
        Some(text("Records")),
        vec![
            node(
                "visual_record_name",
                Component::Text,
                Some(Expr::Item {
                    field: "name".into(),
                }),
                vec![],
            ),
            status,
        ],
    );
    table.collection = Some("habits".into());
    table.options = vec!["Name".into(), "Status".into()];
    let overview = node(
        "visual_overview",
        Component::Stack,
        None,
        vec![icon, image, chart, calendar, add, table],
    );
    let mut tabs = node(
        "visual_tabs",
        Component::Tabs,
        Some(text("Workspace")),
        vec![app.screens[0].root.clone(), overview],
    );
    tabs.options = vec!["Profile".into(), "Overview".into()];
    app.screens[0].root = node(
        "visual_root",
        Component::Stack,
        None,
        vec![
            node(
                "visual_heading",
                Component::Heading,
                Some(text("Visual components")),
                vec![],
            ),
            tabs,
        ],
    );
    app.actions.insert(
        "invalid_chart".into(),
        Action::Sequence {
            actions: vec![
                Action::Set {
                    key: "name".into(),
                    value: text("Should roll back"),
                },
                Action::Set {
                    key: "chart".into(),
                    value: Expr::Literal {
                        value: Value::List(vec![point("", "1")]),
                    },
                },
            ],
        },
    );
    app.event_schema
        .insert("invalid_chart".into(), BTreeMap::new());
    app
}
