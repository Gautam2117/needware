//! Canonical, model-independent Needware application language.
pub mod examples;
pub mod visuals_example;
pub mod widgets_example;
use needware_capabilities::Capability;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

macro_rules! domain {
    ($($item:item)*) => {$ (
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
        $item
    )*};
}

domain! {
    #[serde(deny_unknown_fields)]
    pub struct Application {
        pub schema_version: u16,
        pub runtime_features: Vec<String>,
        pub id: String,
        pub revision: String,
        pub parent: Option<String>,
        pub title: String,
        pub description: String,
        pub locale: String,
        pub messages: BTreeMap<String, BTreeMap<String,String>>,
        pub collections: BTreeMap<String, Collection>,
        pub state: BTreeMap<String, Value>,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        pub state_schema: BTreeMap<String, Field>,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        pub event_schema: BTreeMap<String, BTreeMap<String, Field>>,
        pub screens: Vec<Screen>,
        pub initial_screen: String,
        pub actions: BTreeMap<String, Action>,
        #[ts(type = "import('./Capability').Capability[]")]
        pub capabilities: Vec<Capability>,
        pub theme: Theme,
        pub migrations: Vec<Migration>,
        pub tests: Vec<BehaviorTest>,
    }
    #[serde(tag="type", content="value", rename_all="snake_case", deny_unknown_fields)]
    pub enum Value {
        Null, String(String), Boolean(bool), Integer(String),
        Decimal(Decimal), Date(String), Datetime(String), Duration(String),
        List(Vec<Value>), Map(BTreeMap<String, Value>), Reference(Reference),
    }
    #[serde(deny_unknown_fields)]
    pub struct Decimal { pub coefficient: String, pub scale: u8 }
    #[serde(deny_unknown_fields)]
    pub struct Reference { pub collection: String, pub record: String }
    #[serde(tag="type", rename_all="snake_case", deny_unknown_fields)]
    pub enum DataType {
        String, Boolean, Integer, Decimal { scale:u8 }, Date, Datetime, Duration,
        Enum { values:Vec<String> }, Url,
        Optional { inner:Box<DataType> }, List { item:Box<DataType> },
        Map { value:Box<DataType> }, Record { fields:BTreeMap<String,Field> },
        Reference { collection:String },
    }
    #[serde(deny_unknown_fields)]
    pub struct Field {
        pub data_type: DataType,
        pub default: Option<Value>,
        pub max_length: Option<u32>,
        pub minimum: Option<String>,
        pub maximum: Option<String>,
        pub derived: Option<Expr>,
    }
    #[serde(deny_unknown_fields)]
    pub struct Collection { pub fields:BTreeMap<String,Field>, pub indexes:Vec<Vec<String>> }
    #[serde(deny_unknown_fields)]
    pub struct Screen { pub id:String, pub title:String, pub root:Node }
    #[serde(tag="op", rename_all="snake_case", deny_unknown_fields)]
    pub enum Expr {
        Literal { value:Value }, Event { key:String }, State { key:String },
        Item { field:String }, Collection { name:String },
        Binary { operator:BinaryOp, left:Box<Expr>, right:Box<Expr> },
        Not { value:Box<Expr> }, If { condition:Box<Expr>, yes:Box<Expr>, no:Box<Expr> },
        Length { value:Box<Expr> }, Concat { values:Vec<Expr> },
        Filter { collection:Box<Expr>, predicate:Box<Expr> },
        Map { collection:Box<Expr>, value:Box<Expr> },
        Sort { collection:Box<Expr>, field:String, descending:bool },
        Sum { collection:Box<Expr>, field:String },
        Coalesce { values:Vec<Expr> }, Context { key:ContextKey },
    }
    #[serde(rename_all="snake_case")]
    pub enum BinaryOp { Eq, Ne, Lt, Le, Gt, Ge, Add, Subtract, Multiply, Divide, And, Or }
    #[serde(rename_all="snake_case")]
    pub enum ContextKey { Now, Locale, Timezone }
    #[serde(tag="kind", rename_all="snake_case", deny_unknown_fields)]
    pub enum Action {
        Create { collection:String, id:Expr, values:BTreeMap<String,Expr> },
        Update { collection:String, id:Expr, values:BTreeMap<String,Expr> },
        Delete { collection:String, id:Expr }, Set { key:String, value:Expr },
        Sequence { actions:Vec<Action> }, Parallel { actions:Vec<Action> },
        Conditional { condition:Expr, yes:Box<Action>, no:Option<Box<Action>> },
        Navigate { screen:String }, Back, Open { overlay:String }, Close { overlay:String },
        Effect { capability:Capability, input:Expr },
    }
    #[serde(deny_unknown_fields)]
    pub struct Node {
        pub id:String,
        pub kind:Component,
        pub text:Option<Expr>,
        #[serde(default, skip_serializing_if="Option::is_none")]
        pub value:Option<Expr>,
        #[serde(default, skip_serializing_if="Option::is_none")]
        pub disabled:Option<Expr>,
        pub collection:Option<String>,
        pub field:Option<String>,
        pub action:Option<String>,
        pub options:Vec<String>,
        pub children:Vec<Node>,
        pub style:Style,
    }
    #[serde(rename_all="snake_case")]
    pub enum Component {
        Text, Heading, Button, Icon, Image, Stack, Row, Grid, Card, Divider, Spacer,
        List, Table, Form, TextInput, NumericInput, DateInput, DatetimeInput,
        Checkbox, Toggle, Radio, Select, MultiSelect, Slider, Textarea,
        Tabs, Modal, Drawer, Alert, Badge, Progress, Stat, Chart, EmptyState, Calendar,
    }
    #[serde(deny_unknown_fields)]
    pub struct Style { pub tone:Tone, pub size:Size }
    #[serde(rename_all="snake_case")]
    pub enum Tone { Neutral, Accent, Positive, Warning, Danger }
    #[serde(rename_all="snake_case")]
    pub enum Size { Small, Medium, Large }
    #[serde(deny_unknown_fields)]
    pub struct Theme { pub accent:Accent, pub density:Density, pub radius:Radius }
    #[serde(rename_all="snake_case")]
    pub enum Accent { Indigo, Teal, Amber, Rose }
    #[serde(rename_all="snake_case")]
    pub enum Density { Comfortable, Compact }
    #[serde(rename_all="snake_case")]
    pub enum Radius { Square, Rounded, Soft }
    #[serde(deny_unknown_fields)]
    pub struct Migration { pub from_revision:String, pub operations:Vec<MigrationOp> }
    #[serde(tag="kind", rename_all="snake_case", deny_unknown_fields)]
    pub enum MigrationOp {
        AddField { collection:String, field:String, default:Value },
        RenameField { collection:String, from:String, to:String },
        RemoveField { collection:String, field:String },
        AddCollection { name:String }, RemoveCollection { name:String },
        Transform { collection:String, field:String, value:Expr },
    }
    #[serde(deny_unknown_fields)]
    pub struct BehaviorTest { pub name:String, pub action:String, pub event:BTreeMap<String,Value>, pub assertion:Expr }
    #[serde(deny_unknown_fields)]
    pub struct State { pub revision:String, pub values:BTreeMap<String,Value>, pub collections:BTreeMap<String,BTreeMap<String,BTreeMap<String,Value>>> }
}

pub const IR_VERSION: u16 = 1;
pub const MAX_IR_BYTES: usize = 2 * 1024 * 1024;

impl State {
    pub fn empty(app: &Application) -> Self {
        Self {
            revision: app.revision.clone(),
            values: app.state.clone(),
            collections: app
                .collections
                .keys()
                .map(|k| (k.clone(), BTreeMap::new()))
                .collect(),
        }
    }
}

impl Value {
    pub fn text(&self) -> String {
        match self {
            Self::Null => String::new(),
            Self::String(s)
            | Self::Integer(s)
            | Self::Date(s)
            | Self::Datetime(s)
            | Self::Duration(s) => s.clone(),
            Self::Boolean(b) => b.to_string(),
            Self::Decimal(d) => format!("{}e-{}", d.coefficient, d.scale),
            _ => serde_json::to_string(self).unwrap_or_default(),
        }
    }
}
