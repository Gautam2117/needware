//! Compact guidance for JSON-object providers. This never replaces the full
//! canonical schema used by decoding, validation, or package verification.
use serde_json::Value;
use std::collections::BTreeSet;

pub(crate) fn compact(schema: &Value) -> String {
    fn shape(value: &Value) -> String {
        let Some(object) = value.as_object() else {
            return value.to_string();
        };
        let mut consumed: BTreeSet<&str> = [
            "$defs",
            "$schema",
            "title",
            "description",
            "default",
            "examples",
        ]
        .into();
        let mut text = if let Some(reference) = object.get("$ref").and_then(Value::as_str) {
            consumed.insert("$ref");
            reference
                .strip_prefix("#/$defs/")
                .unwrap_or(reference)
                .to_owned()
        } else if let Some(value) = object.get("const") {
            consumed.insert("const");
            value.to_string()
        } else if let Some(values) = object.get("enum").and_then(Value::as_array) {
            consumed.insert("enum");
            values
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("|")
        } else if let Some(properties) = object.get("properties").and_then(Value::as_object) {
            consumed.extend(["type", "properties", "required", "additionalProperties"]);
            let required = object.get("required").and_then(Value::as_array);
            let fields = properties
                .iter()
                .map(|(name, rule)| {
                    let optional = if required
                        .is_some_and(|keys| keys.iter().any(|key| key.as_str() == Some(name)))
                    {
                        ""
                    } else {
                        "?"
                    };
                    format!("{name}{optional}:{}", shape(rule))
                })
                .collect::<Vec<_>>()
                .join(";");
            let extra = match object.get("additionalProperties") {
                Some(Value::Bool(false)) => "!extra".into(),
                Some(rule) => format!(";extra:{}", shape(rule)),
                None => ";extra:any".into(),
            };
            format!("{{{fields}}}{extra}")
        } else if let Some(items) = object.get("items") {
            consumed.extend(["type", "items"]);
            format!("[{}]", shape(items))
        } else if let Some(rule) = object.get("additionalProperties") {
            consumed.extend(["type", "additionalProperties"]);
            format!("map<string,{}>", shape(rule))
        } else {
            consumed.insert("type");
            object.get("type").map_or_else(
                || "any".into(),
                |value| {
                    value
                        .as_str()
                        .map_or_else(|| value.to_string(), str::to_owned)
                },
            )
        };
        for (keyword, separator) in [("oneOf", " xor "), ("anyOf", " | "), ("allOf", " & ")] {
            if let Some(branches) = object.get(keyword).and_then(Value::as_array) {
                consumed.insert(keyword);
                let choices = branches
                    .iter()
                    .map(shape)
                    .collect::<Vec<_>>()
                    .join(separator);
                if text == "any" {
                    text = format!("({choices})");
                } else {
                    text.push_str(&format!(" & ({choices})"));
                }
            }
        }
        // Preserve every other constraint verbatim, including patterns, bounds,
        // formats, conditionals and uniqueness. Annotations have no authority.
        let qualifiers: serde_json::Map<String, Value> = object
            .iter()
            .filter(|(key, _)| !consumed.contains(key.as_str()))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        if !qualifiers.is_empty() {
            text.push('@');
            text.push_str(&Value::Object(qualifiers).to_string());
        }
        text
    }
    let mut result = String::from(
        "JSON contract: ? means optional; | allows alternatives; xor means exactly one alternative; & combines constraints; !extra forbids extra object keys; @ retains JSON Schema constraints. Return JSON, never this notation.\nRoot=",
    );
    result.push_str(&shape(schema));
    if let Some(definitions) = schema.get("$defs").and_then(Value::as_object) {
        for (name, definition) in definitions {
            result.push('\n');
            result.push_str(name);
            result.push('=');
            result.push_str(&shape(definition));
        }
    }
    result
}
