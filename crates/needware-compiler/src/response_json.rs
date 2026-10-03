//! Provider metadata permits finite floats; application IR uses a stricter parser.
use serde::{
    Deserialize, Deserializer,
    de::{self, MapAccess, SeqAccess, Visitor},
};
use serde_json::{Map, Number, Value};
use std::fmt;
pub struct Response(pub Value);
impl<'de> Deserialize<'de> for Response {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Metadata;
        impl<'de> Visitor<'de> for Metadata {
            type Value = Value;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("duplicate-free provider response")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Value, E> {
                Ok(Value::Bool(v))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Value, E> {
                Ok(Value::Number(v.into()))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Value, E> {
                Ok(Value::Number(v.into()))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Value, E> {
                Number::from_f64(v)
                    .map(Value::Number)
                    .ok_or_else(|| E::custom("nonfinite metadata"))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Value, E> {
                Ok(Value::String(v.into()))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
                Ok(Value::Null)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Value, A::Error> {
                let mut out = vec![];
                while let Some(value) = a.next_element::<Response>()? {
                    out.push(value.0);
                }
                Ok(Value::Array(out))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Value, A::Error> {
                let mut out = Map::new();
                while let Some((key, value)) = a.next_entry::<String, Response>()? {
                    if out.insert(key, value.0).is_some() {
                        return Err(de::Error::custom("duplicate response member"));
                    }
                }
                Ok(Value::Object(out))
            }
        }
        deserializer.deserialize_any(Metadata).map(Response)
    }
}
