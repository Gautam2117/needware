use super::*;
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct Raster {
    pub digest: String,
    pub media_type: String,
    pub bytes_hex: String,
    pub width: u32,
    pub height: u32,
}
#[derive(Default)]
pub(crate) struct RenderMeter {
    pub nodes: u32,
    pub raster_bytes: usize,
    pub raster_pixels: u64,
}
fn invalid(message: &str) -> RuntimeError {
    RuntimeError::Invalid(message.into())
}
pub(crate) fn prepare(
    node: &Node,
    value: &Option<Value>,
    text: &str,
    package: &VerifiedPackage,
    meter: &mut RenderMeter,
) -> Result<Option<Raster>, RuntimeError> {
    if matches!(
        node.kind,
        Component::Image
            | Component::Icon
            | Component::Chart
            | Component::Calendar
            | Component::Table
            | Component::Tabs
    ) && text.len() > 256
    {
        return Err(invalid("visual description exceeds 256 bytes"));
    }
    match node.kind {
        Component::Image => {
            if text.is_empty() && (node.options != ["decorative"] || node.action.is_some()) {
                return Err(invalid("image requires a description or decorative marker"));
            }
            let Some(Value::String(digest)) = value else {
                return Err(invalid("image requires a signed asset digest"));
            };
            let asset = package
                .assets()
                .get(digest)
                .ok_or_else(|| invalid("image asset is missing from its verified package"))?;
            let (width, height) = package
                .raster_dimensions(digest)
                .map_err(|error| invalid(&error.to_string()))?;
            meter.raster_pixels = meter
                .raster_pixels
                .checked_add(u64::from(width) * u64::from(height))
                .ok_or(RuntimeError::Limit)?;
            if meter.raster_pixels > 16 * 1024 * 1024 {
                return Err(RuntimeError::Limit);
            }
            let encoded = asset
                .bytes
                .len()
                .checked_mul(2)
                .ok_or(RuntimeError::Limit)?;
            meter.raster_bytes = meter
                .raster_bytes
                .checked_add(encoded)
                .ok_or(RuntimeError::Limit)?;
            if meter.raster_bytes > 16 * 1024 * 1024 {
                return Err(RuntimeError::Limit);
            }
            Ok(Some(Raster {
                digest: digest.clone(),
                media_type: asset.media_type.clone(),
                bytes_hex: hex::encode(&asset.bytes),
                width,
                height,
            }))
        }
        Component::Chart => {
            chart(value)?;
            Ok(None)
        }
        Component::Calendar => {
            calendar(value)?;
            Ok(None)
        }
        Component::Icon if text.is_empty() => {
            Err(invalid("icon requires an accessible description"))
        }
        _ => Ok(None),
    }
}
fn chart(value: &Option<Value>) -> Result<(), RuntimeError> {
    let Some(Value::List(rows)) = value else {
        return Err(invalid("chart requires a list of label/value records"));
    };
    if rows.len() > 100 {
        return Err(RuntimeError::Limit);
    }
    for row in rows {
        let Value::Map(fields) = row else {
            return Err(invalid("invalid chart record"));
        };
        if fields.len() != 2
            || !matches!(fields.get("label"),Some(Value::String(label)) if !label.is_empty()&&label.len()<=120)
            || !matches!(fields.get("value"),Some(Value::Integer(value)) if value.parse::<i64>().is_ok_and(|number|number.to_string()==*value))
        {
            return Err(invalid(
                "chart records require a bounded label and canonical signed integer",
            ));
        }
    }
    Ok(())
}
fn date(value: &Value) -> Option<&str> {
    let Value::Date(date) = value else {
        return None;
    };
    let field = Field {
        data_type: DataType::Date,
        default: None,
        max_length: None,
        minimum: None,
        maximum: None,
        derived: None,
    };
    if date.len() != 10
        || !date.get(..4)?.parse::<u16>().is_ok_and(|year| year >= 1900)
        || needware_validation::validate_value(value, &field, 0).is_err()
    {
        return None;
    }
    Some(date)
}
fn calendar(value: &Option<Value>) -> Result<(), RuntimeError> {
    let Some(Value::Map(fields)) = value else {
        return Err(invalid("calendar requires month and events"));
    };
    let month = fields
        .get("month")
        .and_then(date)
        .filter(|date| date.ends_with("-01"))
        .ok_or_else(|| invalid("calendar month must be a valid first day from 1900 onward"))?;
    let Some(Value::List(events)) = fields.get("events") else {
        return Err(invalid("calendar requires an event list"));
    };
    if fields.len() != 2 || events.len() > 100 {
        return Err(RuntimeError::Limit);
    }
    for event in events {
        let Value::Map(fields) = event else {
            return Err(invalid("invalid calendar event"));
        };
        if fields.len() != 2
            || !fields
                .get("date")
                .and_then(date)
                .is_some_and(|date| date[..7] == month[..7])
            || !matches!(fields.get("label"),Some(Value::String(label)) if !label.is_empty()&&label.len()<=120)
        {
            return Err(invalid(
                "calendar events require a date within the month and a bounded label",
            ));
        }
    }
    Ok(())
}
