use super::*;
use examples::{node, text};
pub fn application() -> Application {
    let mut app = examples::typed_habit_tracker();
    app.title = "Typed widgets fixture".into();
    app.runtime_features.extend([
        "declarative_widgets_v1".into(),
        "exact_arithmetic_v1".into(),
    ]);
    let choices = vec!["Calm".into(), "Bright".into()];
    let declarations = [
        (
            "name",
            Component::TextInput,
            "Name",
            DataType::String,
            Value::String("Original".into()),
        ),
        (
            "amount",
            Component::NumericInput,
            "Amount",
            DataType::Decimal { scale: 2 },
            Value::Decimal(Decimal {
                coefficient: "900719925474099301".into(),
                scale: 2,
            }),
        ),
        (
            "accepted",
            Component::Checkbox,
            "Accepted",
            DataType::Boolean,
            Value::Boolean(false),
        ),
        (
            "notify",
            Component::Toggle,
            "Notify",
            DataType::Boolean,
            Value::Boolean(false),
        ),
        (
            "mode",
            Component::Select,
            "Mode",
            DataType::Enum {
                values: choices.clone(),
            },
            Value::String("Calm".into()),
        ),
        (
            "priority",
            Component::Radio,
            "Priority",
            DataType::Enum {
                values: choices.clone(),
            },
            Value::String("Calm".into()),
        ),
        (
            "labels",
            Component::MultiSelect,
            "Labels",
            DataType::List {
                item: Box::new(DataType::Enum {
                    values: choices.clone(),
                }),
            },
            Value::List(vec![]),
        ),
        (
            "level",
            Component::Slider,
            "Level",
            DataType::Integer,
            Value::Integer("20".into()),
        ),
        (
            "birthday",
            Component::DateInput,
            "Birthday",
            DataType::Date,
            Value::Date("2026-10-05".into()),
        ),
        (
            "at",
            Component::DatetimeInput,
            "At",
            DataType::Datetime,
            Value::Datetime("2026-10-05T12:00:00Z".into()),
        ),
    ];
    let mut fields = BTreeMap::new();
    let mut inputs = vec![];
    let mut save = vec![];
    for (key, kind, label, data_type, value) in declarations {
        let field = Field {
            data_type,
            default: None,
            max_length: if key == "name" { Some(120) } else { None },
            minimum: if key == "level" {
                Some("0".into())
            } else {
                None
            },
            maximum: if key == "level" {
                Some("100".into())
            } else {
                None
            },
            derived: None,
        };
        app.state.insert(key.into(), value);
        app.state_schema.insert(key.into(), field.clone());
        fields.insert(key.into(), field);
        let mut input = node(&format!("input_{key}"), kind, Some(text(label)), vec![]);
        input.field = Some(key.into());
        input.value = Some(Expr::State { key: key.into() });
        if matches!(
            input.kind,
            Component::Select | Component::Radio | Component::MultiSelect
        ) {
            input.options = choices.clone();
        }
        inputs.push(input);
        save.push(Action::Set {
            key: key.into(),
            value: Expr::Event { key: key.into() },
        });
    }
    app.actions
        .insert("save_primary".into(), Action::Sequence { actions: save });
    app.event_schema.insert("save_primary".into(), fields);
    let field = app.state_schema["name"].clone();
    app.state.insert(
        "secondary_name".into(),
        Value::String("Second original".into()),
    );
    app.state_schema
        .insert("secondary_name".into(), field.clone());
    app.actions.insert(
        "save_secondary".into(),
        Action::Set {
            key: "secondary_name".into(),
            value: Expr::Event { key: "name".into() },
        },
    );
    app.event_schema.insert(
        "save_secondary".into(),
        BTreeMap::from([("name".into(), field)]),
    );
    let mut primary = node(
        "primary_form",
        Component::Form,
        Some(text("Save profile")),
        inputs,
    );
    primary.action = Some("save_primary".into());
    let mut secondary_input = node(
        "secondary_input",
        Component::TextInput,
        Some(text("Second name")),
        vec![],
    );
    secondary_input.field = Some("name".into());
    secondary_input.value = Some(Expr::State {
        key: "secondary_name".into(),
    });
    let mut secondary = node(
        "secondary_form",
        Component::Form,
        Some(text("Save second profile")),
        vec![secondary_input],
    );
    secondary.action = Some("save_secondary".into());
    app.actions.insert(
        "change_name".into(),
        Action::Set {
            key: "name".into(),
            value: text("Server changed"),
        },
    );
    app.event_schema
        .insert("change_name".into(), BTreeMap::new());
    app.actions.insert(
        "invalid_progress".into(),
        Action::Set {
            key: "level".into(),
            value: Expr::Literal {
                value: Value::Integer("101".into()),
            },
        },
    );
    app.event_schema
        .insert("invalid_progress".into(), BTreeMap::new());
    let mut change = node(
        "change_button",
        Component::Button,
        Some(text("Change saved name")),
        vec![],
    );
    change.action = Some("change_name".into());
    let mut progress = node(
        "level_progress",
        Component::Progress,
        Some(text("Progress")),
        vec![],
    );
    progress.value = Some(Expr::State {
        key: "level".into(),
    });
    app.screens = vec![Screen {
        id: "widgets_home".into(),
        title: "Typed widgets".into(),
        root: node(
            "widgets_root",
            Component::Stack,
            None,
            vec![
                node(
                    "widgets_heading",
                    Component::Heading,
                    Some(text("Typed widgets")),
                    vec![],
                ),
                primary,
                secondary,
                change,
                progress,
            ],
        ),
    }];
    app.initial_screen = "widgets_home".into();
    app
}
