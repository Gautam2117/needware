//! Acyclic provider representation, mechanically projected from the canonical schema.
//! Recursive domain values are table references; maps are unique key/value arrays.
use crate::CompileError;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

const TABLES: [(&str, &str); 5] = [
    ("Expr", "expressions"),
    ("Action", "actions"),
    ("DataType", "types"),
    ("Value", "values"),
    ("Node", "nodes"),
];
pub struct WireSchema {
    canonical: Value,
    provider: Value,
}
impl Default for WireSchema {
    fn default() -> Self {
        Self::new()
    }
}
impl WireSchema {
    pub fn new() -> Self {
        let canonical = schemars::schema_for!(needware_ir::Application).to_value();
        let mut root = canonical.clone();
        if let Some(object) = root.as_object_mut() {
            object.remove("$defs");
            object.remove("$schema");
        }
        let mut properties = Map::new();
        properties.insert("application".into(), project(&root));
        for (name, table) in TABLES {
            properties.insert(
                table.into(),
                json!({"type":"array","items":project(&canonical["$defs"][name])}),
            );
        }
        let mut definitions = Map::new();
        if let Some(defs) = canonical["$defs"].as_object() {
            for (name, value) in defs {
                if !TABLES.iter().any(|(n, _)| n == name) {
                    definitions.insert(name.clone(), project(value));
                }
            }
        }
        let provider = json!({"type":"object","properties":properties,"required":["application","expressions","actions","types","values","nodes"],"additionalProperties":false,"$defs":definitions});
        Self {
            canonical,
            provider,
        }
    }
    pub fn schema(&self) -> &Value {
        &self.provider
    }
    pub fn canonical_schema(&self) -> Value {
        let mut schema = self.canonical.clone();
        for identity in ["id", "revision"] {
            schema["properties"][identity] = json!({"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"});
        }
        schema["$defs"]["Node"]["properties"]["id"] =
            json!({"type":"string","pattern":"^[A-Za-z0-9_]{1,64}$"});
        // Contract fields describe inputs/state types, unlike collection fields with defaults.
        let mut contract = schema["$defs"]["Field"].clone();
        contract["properties"]["default"] = json!({"type":"null"});
        contract["properties"]["derived"] = json!({"type":"null"});
        schema["properties"]["state_schema"]["additionalProperties"] = contract.clone();
        schema["properties"]["event_schema"]["additionalProperties"]["additionalProperties"] =
            contract;
        schema
    }
    pub fn decode_canonical(&self, bytes: &[u8]) -> Result<needware_ir::Application, CompileError> {
        let app =
            needware_package::parse_json::<needware_ir::Application>(bytes).map_err(|error| {
                CompileError::Diagnostics {
                    path: "application".into(),
                    message: error.to_string().chars().take(256).collect(),
                }
            })?;
        // Retain wire table, nesting and decoder fuel bounds for this representation too.
        self.decode(&self.encode(&app)?)
    }
    pub fn encode(&self, application: &needware_ir::Application) -> Result<Value, CompileError> {
        let mut value =
            serde_json::to_value(application).map_err(|_| CompileError::InvalidOutput)?;
        // Packages omit empty additive contracts to preserve legacy content identity.
        // Provider structured output supplies every property, including empty maps.
        let object = value.as_object_mut().ok_or(CompileError::InvalidOutput)?;
        for name in ["state_schema", "event_schema"] {
            object.entry(name).or_insert_with(|| json!({}));
        }
        let mut tables: BTreeMap<&str, Vec<Value>> =
            TABLES.iter().map(|(_, t)| (*t, vec![])).collect();
        let app = self.encode_at(&value, &self.canonical, &mut tables, 0)?;
        let mut result = Map::new();
        result.insert("application".into(), app);
        for (key, value) in tables {
            result.insert(key.into(), Value::Array(value));
        }
        Ok(Value::Object(result))
    }
    fn encode_at(
        &self,
        value: &Value,
        schema: &Value,
        tables: &mut BTreeMap<&str, Vec<Value>>,
        depth: usize,
    ) -> Result<Value, CompileError> {
        if depth > 64 {
            return Err(CompileError::InvalidOutput);
        }
        if let Some(reference) = schema["$ref"].as_str() {
            let name = reference
                .strip_prefix("#/$defs/")
                .ok_or(CompileError::InvalidOutput)?;
            let encoded =
                self.encode_at(value, &self.canonical["$defs"][name], tables, depth + 1)?;
            if let Some((_, table)) = TABLES.iter().find(|(n, _)| *n == name) {
                let nodes = tables.get_mut(table).ok_or(CompileError::InvalidOutput)?;
                let index = nodes.len();
                if index >= 8192 {
                    return Err(CompileError::InvalidOutput);
                }
                nodes.push(encoded);
                return Ok(json!(index));
            }
            return Ok(encoded);
        }
        let schema = select(schema, value, &self.canonical, false)?;
        if schema.get("$ref").is_some() {
            return self.encode_at(value, schema, tables, depth + 1);
        }
        if let Some(map) = schema["additionalProperties"].as_object() {
            let _ = map;
            let entries = value.as_object().ok_or(CompileError::InvalidOutput)?;
            return entries.iter().map(|(key, value)| Ok(json!({"key":key,"value":self.encode_at(value, &schema["additionalProperties"], tables, depth + 1)?}))).collect::<Result<Vec<_>, _>>().map(Value::Array);
        }
        if let Some(properties) = schema["properties"].as_object() {
            let object = value.as_object().ok_or(CompileError::InvalidOutput)?;
            let mut out = Map::new();
            for (key, field) in properties {
                out.insert(
                    key.clone(),
                    self.encode_at(
                        object.get(key).unwrap_or(&Value::Null),
                        field,
                        tables,
                        depth + 1,
                    )?,
                );
            }
            return Ok(Value::Object(out));
        }
        if schema["type"] == "array" {
            return value
                .as_array()
                .ok_or(CompileError::InvalidOutput)?
                .iter()
                .map(|v| self.encode_at(v, &schema["items"], tables, depth + 1))
                .collect::<Result<Vec<_>, _>>()
                .map(Value::Array);
        }
        Ok(value.clone())
    }
    pub fn decode(&self, wire: &Value) -> Result<needware_ir::Application, CompileError> {
        let object = wire.as_object().ok_or(CompileError::InvalidOutput)?;
        if object.len() != 6 {
            return Err(CompileError::InvalidOutput);
        }
        for (_, table) in TABLES {
            if !wire[table].is_array() || wire[table].as_array().is_some_and(|v| v.len() > 8192) {
                return Err(CompileError::InvalidOutput);
            }
        }
        let mut decoder = Decoder {
            schema: &self.canonical,
            wire,
            active: BTreeSet::new(),
            fuel: 32768,
        };
        let value = decoder.at(&wire["application"], &self.canonical, 0)?;
        let bytes = serde_json::to_vec(&value).map_err(|_| CompileError::InvalidOutput)?;
        if bytes.len() > needware_ir::MAX_IR_BYTES {
            return Err(CompileError::InvalidOutput);
        }
        serde_json::from_slice(&bytes).map_err(|_| CompileError::InvalidOutput)
    }
}
fn project(schema: &Value) -> Value {
    if let Some(reference) = schema["$ref"].as_str()
        && TABLES
            .iter()
            .any(|(n, _)| reference == format!("#/$defs/{n}"))
    {
        return json!({"type":"integer"});
    }
    if schema["additionalProperties"].is_object() {
        return json!({"type":"array","items":{"type":"object","properties":{"key":{"type":"string"},"value":project(&schema["additionalProperties"])},"required":["key","value"],"additionalProperties":false}});
    }
    match schema {
        Value::Object(fields) => {
            let mut out: Map<String, Value> = fields
                .iter()
                .filter(|(k, _)| {
                    !matches!(
                        k.as_str(),
                        "$schema"
                            | "title"
                            | "format"
                            | "default"
                            | "minimum"
                            | "maximum"
                            | "minLength"
                            | "maxLength"
                    )
                })
                .map(|(k, v)| {
                    (
                        if k == "oneOf" {
                            "anyOf".into()
                        } else {
                            k.clone()
                        },
                        project(v),
                    )
                })
                .collect();
            if let Some(properties) = out.get("properties").and_then(Value::as_object) {
                let required: Vec<_> = properties.keys().cloned().collect();
                out.insert("required".into(), json!(required));
                out.insert("additionalProperties".into(), json!(false));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(project).collect()),
        _ => schema.clone(),
    }
}
fn matches(schema: &Value, value: &Value, root: &Value, wire: bool) -> bool {
    if let Some(reference) = schema["$ref"].as_str() {
        if wire
            && TABLES
                .iter()
                .any(|(n, _)| reference == format!("#/$defs/{n}"))
        {
            return value.is_u64();
        }
        return reference
            .strip_prefix('#')
            .and_then(|p| root.pointer(p))
            .is_some_and(|s| matches(s, value, root, wire));
    }
    if let Some(constant) = schema.get("const") {
        return constant == value;
    }
    if let Some(types) = schema["type"].as_array() {
        return types
            .iter()
            .any(|t| matches(&json!({"type":t}), value, root, wire));
    }
    match schema["type"].as_str() {
        Some("null") => value.is_null(),
        Some("string") => value.is_string(),
        Some("integer") => value.is_i64() || value.is_u64(),
        Some("boolean") => value.is_boolean(),
        Some("array") => value.is_array(),
        Some("object") if schema["additionalProperties"].is_object() && wire => value.is_array(),
        Some("object") => {
            value.is_object()
                && schema["properties"].as_object().is_none_or(|p| {
                    p.iter().all(|(k, s)| {
                        !s.get("const").is_some()
                            || value.get(k).is_some_and(|v| matches(s, v, root, wire))
                    })
                })
        }
        _ => schema
            .get("anyOf")
            .or_else(|| schema.get("oneOf"))
            .and_then(Value::as_array)
            .is_none_or(|a| a.iter().any(|s| matches(s, value, root, wire))),
    }
}
fn select<'a>(
    schema: &'a Value,
    value: &Value,
    root: &Value,
    wire: bool,
) -> Result<&'a Value, CompileError> {
    if let Some(branches) = schema
        .get("anyOf")
        .or_else(|| schema.get("oneOf"))
        .and_then(Value::as_array)
    {
        return branches
            .iter()
            .find(|s| matches(s, value, root, wire))
            .ok_or(CompileError::InvalidOutput);
    }
    Ok(schema)
}
struct Decoder<'a> {
    schema: &'a Value,
    wire: &'a Value,
    active: BTreeSet<(String, usize)>,
    fuel: usize,
}
impl Decoder<'_> {
    fn at(&mut self, value: &Value, schema: &Value, depth: usize) -> Result<Value, CompileError> {
        if depth > 64 || self.fuel == 0 {
            return Err(CompileError::InvalidOutput);
        }
        self.fuel -= 1;
        if let Some(reference) = schema["$ref"].as_str() {
            let name = reference
                .strip_prefix("#/$defs/")
                .ok_or(CompileError::InvalidOutput)?;
            if let Some((_, table)) = TABLES.iter().find(|(n, _)| *n == name) {
                let index = usize::try_from(value.as_u64().ok_or(CompileError::InvalidOutput)?)
                    .map_err(|_| CompileError::InvalidOutput)?;
                let node = self.wire[table]
                    .as_array()
                    .and_then(|a| a.get(index))
                    .ok_or(CompileError::InvalidOutput)?;
                let identity = (name.to_owned(), index);
                if !self.active.insert(identity.clone()) {
                    return Err(CompileError::InvalidOutput);
                }
                let result = self.at(node, &self.schema["$defs"][name], depth + 1);
                self.active.remove(&identity);
                return result;
            }
            return self.at(value, &self.schema["$defs"][name], depth + 1);
        }
        let schema = select(schema, value, self.schema, true)?;
        if schema.get("$ref").is_some() {
            return self.at(value, schema, depth + 1);
        }
        if schema["additionalProperties"].is_object() {
            let mut out = Map::new();
            for entry in value.as_array().ok_or(CompileError::InvalidOutput)? {
                if entry.as_object().is_none_or(|o| o.len() != 2) {
                    return Err(CompileError::InvalidOutput);
                }
                let key = entry["key"].as_str().ok_or(CompileError::InvalidOutput)?;
                if out.contains_key(key) {
                    return Err(CompileError::InvalidOutput);
                }
                out.insert(
                    key.into(),
                    self.at(&entry["value"], &schema["additionalProperties"], depth + 1)?,
                );
            }
            return Ok(Value::Object(out));
        }
        if let Some(properties) = schema["properties"].as_object() {
            let object = value.as_object().ok_or(CompileError::InvalidOutput)?;
            if object.keys().any(|key| !properties.contains_key(key)) {
                return Err(CompileError::InvalidOutput);
            }
            let mut out = Map::new();
            for (key, field) in properties {
                out.insert(
                    key.clone(),
                    self.at(
                        object.get(key).ok_or(CompileError::InvalidOutput)?,
                        field,
                        depth + 1,
                    )?,
                );
            }
            return Ok(Value::Object(out));
        }
        if schema["type"] == "array" {
            return value
                .as_array()
                .ok_or(CompileError::InvalidOutput)?
                .iter()
                .map(|v| self.at(v, &schema["items"], depth + 1))
                .collect::<Result<Vec<_>, _>>()
                .map(Value::Array);
        }
        Ok(value.clone())
    }
}
