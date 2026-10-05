//! Authored application definitions, never represented as model generation.
use crate::*;
pub fn runtime_controls_demo() -> Application {
    fn button(id: &str, label: &str, action: &str) -> Node {
        let mut result = node(id, Component::Button, Some(text(label)), vec![]);
        result.action = Some(action.into());
        result
    }
    let mut app = habit_tracker();
    app.title = "Runtime controls fixture".into();
    app.runtime_features.push("runtime_controls_v1".into());
    app.state
        .insert("counter".into(), Value::Integer("0".into()));
    for (name, action) in [
        (
            "details",
            Action::Navigate {
                screen: "controls_details".into(),
            },
        ),
        (
            "review",
            Action::Navigate {
                screen: "controls_review".into(),
            },
        ),
        (
            "home",
            Action::Navigate {
                screen: "controls_home".into(),
            },
        ),
        ("back", Action::Back),
        (
            "show_dialog",
            Action::Open {
                overlay: "control_dialog".into(),
            },
        ),
        (
            "close_dialog",
            Action::Close {
                overlay: "control_dialog".into(),
            },
        ),
        (
            "show_drawer",
            Action::Open {
                overlay: "control_drawer".into(),
            },
        ),
        (
            "close_drawer",
            Action::Close {
                overlay: "control_drawer".into(),
            },
        ),
        (
            "sequence_navigation",
            Action::Sequence {
                actions: vec![
                    Action::Navigate {
                        screen: "controls_details".into(),
                    },
                    Action::Navigate {
                        screen: "controls_review".into(),
                    },
                    Action::Back,
                ],
            },
        ),
        (
            "failed_navigation",
            Action::Sequence {
                actions: vec![
                    Action::Set {
                        key: "counter".into(),
                        value: Expr::Literal {
                            value: Value::Integer("1".into()),
                        },
                    },
                    Action::Navigate {
                        screen: "controls_details".into(),
                    },
                    Action::Delete {
                        collection: "habits".into(),
                        id: text("not_a_uuid"),
                    },
                ],
            },
        ),
    ] {
        app.actions.insert(name.into(), action);
    }
    let mut modal = node(
        "control_dialog",
        Component::Modal,
        Some(text("Review dialog")),
        vec![node(
            "dialog_text",
            Component::Text,
            Some(text(
                "Your application data remains separate from navigation.",
            )),
            vec![],
        )],
    );
    modal.action = Some("close_dialog".into());
    let mut drawer = node(
        "control_drawer",
        Component::Drawer,
        Some(text("Preferences drawer")),
        vec![node(
            "drawer_text",
            Component::Text,
            Some(text("A controlled drawer")),
            vec![],
        )],
    );
    drawer.action = Some("close_drawer".into());
    app.screens = vec![
        Screen {
            id: "controls_home".into(),
            title: "Controls".into(),
            root: node(
                "controls_home_root",
                Component::Stack,
                None,
                vec![
                    node(
                        "home_heading",
                        Component::Heading,
                        Some(text("Controls home")),
                        vec![],
                    ),
                    button("details_button", "Open details", "details"),
                    button("dialog_button", "Show dialog", "show_dialog"),
                    button("drawer_button", "Show drawer", "show_drawer"),
                    button(
                        "failure_button",
                        "Fail atomic navigation",
                        "failed_navigation",
                    ),
                    node(
                        "counter_view",
                        Component::Text,
                        Some(Expr::State {
                            key: "counter".into(),
                        }),
                        vec![],
                    ),
                    modal,
                    drawer,
                ],
            ),
        },
        Screen {
            id: "controls_details".into(),
            title: "Details".into(),
            root: node(
                "controls_details_root",
                Component::Stack,
                None,
                vec![
                    node(
                        "details_heading",
                        Component::Heading,
                        Some(text("Controls details")),
                        vec![],
                    ),
                    button("review_button", "Open review", "review"),
                    button("details_back", "Back to previous screen", "back"),
                    button("details_home", "Return home", "home"),
                ],
            ),
        },
        Screen {
            id: "controls_review".into(),
            title: "Review".into(),
            root: node(
                "controls_review_root",
                Component::Stack,
                None,
                vec![
                    node(
                        "review_heading",
                        Component::Heading,
                        Some(text("Controls review")),
                        vec![],
                    ),
                    button("review_back", "Back to previous screen", "back"),
                ],
            ),
        },
    ];
    app.initial_screen = "controls_home".into();
    app
}
pub(crate) fn text(s: &str) -> Expr {
    Expr::Literal {
        value: Value::String(s.into()),
    }
}
pub(crate) fn node(id: &str, kind: Component, label: Option<Expr>, children: Vec<Node>) -> Node {
    Node {
        id: id.into(),
        kind,
        text: label,
        value: None,
        disabled: None,
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
