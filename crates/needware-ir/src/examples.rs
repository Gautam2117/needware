//! Authored application definitions, never represented as model generation.
use crate::*;
fn text(s: &str) -> Expr {
    Expr::Literal {
        value: Value::String(s.into()),
    }
}
fn node(id: &str, kind: Component, label: Option<Expr>, children: Vec<Node>) -> Node {
    Node {
        id: id.into(),
        kind,
        text: label,
        collection: None,
        field: None,
        action: None,
        options: vec![],
        children,
        style: Style {
            tone: Tone::Neutral,
            size: Size::Medium,
        },
    }
}
pub fn typed_habit_tracker() -> Application {
    let mut app = habit_tracker();
    app.runtime_features.push("typed_contracts_v1".into());
    let input = Field {
        data_type: DataType::String,
        default: None,
        max_length: Some(120),
        minimum: None,
        maximum: None,
        derived: None,
    };
    app.event_schema = app
        .actions
        .keys()
        .map(|action| {
            let mut fields = BTreeMap::from([("record_id".into(), input.clone())]);
            if action == "add" {
                fields.insert("name".into(), input.clone());
            }
            (action.clone(), fields)
        })
        .collect();
    app
}
pub fn habit_tracker() -> Application {
    let mut fields = BTreeMap::new();
    fields.insert(
        "name".into(),
        Field {
            data_type: DataType::String,
            default: None,
            max_length: Some(120),
            minimum: None,
            maximum: None,
            derived: None,
        },
    );
    fields.insert(
        "done".into(),
        Field {
            data_type: DataType::Boolean,
            default: Some(Value::Boolean(false)),
            max_length: None,
            minimum: None,
            maximum: None,
            derived: None,
        },
    );
    let mut input = node(
        "name",
        Component::TextInput,
        Some(text("Habit name")),
        vec![],
    );
    input.field = Some("name".into());
    let mut add = node("add", Component::Button, Some(text("Add habit")), vec![]);
    add.action = Some("add".into());
    let mut toggle = node(
        "toggle",
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
    toggle.action = Some("toggle".into());
    let mut remove = node("remove", Component::Button, Some(text("Remove")), vec![]);
    remove.action = Some("remove".into());
    let mut list = node(
        "habits",
        Component::List,
        None,
        vec![node(
            "habit",
            Component::Card,
            None,
            vec![
                node(
                    "habit_name",
                    Component::Text,
                    Some(Expr::Item {
                        field: "name".into(),
                    }),
                    vec![],
                ),
                toggle,
                remove,
            ],
        )],
    );
    list.collection = Some("habits".into());
    let mut actions = BTreeMap::new();
    actions.insert(
        "add".into(),
        Action::Create {
            collection: "habits".into(),
            id: Expr::Event {
                key: "record_id".into(),
            },
            values: BTreeMap::from([("name".into(), Expr::Event { key: "name".into() })]),
        },
    );
    actions.insert(
        "toggle".into(),
        Action::Update {
            collection: "habits".into(),
            id: Expr::Event {
                key: "record_id".into(),
            },
            values: BTreeMap::from([(
                "done".into(),
                Expr::Not {
                    value: Box::new(Expr::Item {
                        field: "done".into(),
                    }),
                },
            )]),
        },
    );
    actions.insert(
        "remove".into(),
        Action::Delete {
            collection: "habits".into(),
            id: Expr::Event {
                key: "record_id".into(),
            },
        },
    );
    Application {
        schema_version: 1,
        runtime_features: vec![],
        id: "713a48d2-4f71-4217-b313-91b5ba9c9710".into(),
        revision: "713a48d2-4f71-4217-b313-91b5ba9c9711".into(),
        parent: None,
        title: "Habit tracker".into(),
        description: "An authored Needware application. Stored only on this device.".into(),
        locale: "en".into(),
        messages: BTreeMap::new(),
        collections: BTreeMap::from([(
            "habits".into(),
            Collection {
                fields,
                indexes: vec![vec!["name".into()]],
            },
        )]),
        state: BTreeMap::new(),
        state_schema: BTreeMap::new(),
        event_schema: BTreeMap::new(),
        screens: vec![Screen {
            id: "home".into(),
            title: "Habits".into(),
            root: node(
                "root",
                Component::Stack,
                None,
                vec![
                    node(
                        "title",
                        Component::Heading,
                        Some(text("Build a rhythm")),
                        vec![],
                    ),
                    input,
                    add,
                    list,
                ],
            ),
        }],
        initial_screen: "home".into(),
        actions,
        capabilities: vec![Capability::Storage {
            synchronized: false,
            write: true,
            collections: vec!["habits".into()],
        }],
        theme: Theme {
            accent: Accent::Teal,
            density: Density::Comfortable,
            radius: Radius::Soft,
        },
        migrations: vec![],
        tests: vec![],
    }
}
