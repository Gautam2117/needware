//! Deny-by-default capabilities. Authorization never performs an effect.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Capability {
    Storage {
        synchronized: bool,
        write: bool,
        collections: Vec<String>,
    },
    Network {
        origin: String,
        methods: Vec<String>,
        max_bytes: u32,
    },
    Clipboard {
        read: bool,
    },
    Camera,
    Microphone,
    Geolocation,
    Notification {
        push: bool,
    },
    File {
        import: bool,
        media_types: Vec<String>,
        max_bytes: u32,
    },
    Share,
    Ai {
        provider: String,
        models: Vec<String>,
        max_tokens: u32,
    },
    Collaboration {
        write: bool,
    },
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PermissionError {
    #[error("permission denied")]
    Denied,
    #[error("invalid capability scope")]
    InvalidScope,
    #[error("application or revision does not match grant")]
    WrongApplication,
}

impl Capability {
    pub fn validate(&self) -> Result<(), PermissionError> {
        match self {
            Self::Network {
                origin,
                methods,
                max_bytes,
            } => {
                let u = url::Url::parse(origin).map_err(|_| PermissionError::InvalidScope)?;
                if u.scheme() != "https"
                    || u.host_str().is_none()
                    || !u.username().is_empty()
                    || u.password().is_some()
                    || u.query().is_some()
                    || u.fragment().is_some()
                    || u.path() != "/"
                    || u.origin().ascii_serialization() != *origin
                    || *max_bytes == 0
                    || *max_bytes > 8 * 1024 * 1024
                    || methods.is_empty()
                    || methods.iter().any(|m| {
                        !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].contains(&m.as_str())
                    })
                {
                    return Err(PermissionError::InvalidScope);
                }
                if let Some(host) = u.host_str()
                    && (host == "localhost"
                        || host.ends_with(".localhost")
                        || host.parse::<std::net::IpAddr>().is_ok())
                {
                    return Err(PermissionError::InvalidScope);
                }
            }
            Self::File {
                max_bytes,
                media_types,
                ..
            } if *max_bytes == 0 || *max_bytes > 8 * 1024 * 1024 || media_types.is_empty() => {
                return Err(PermissionError::InvalidScope);
            }
            Self::Ai {
                max_tokens,
                provider,
                models,
            } if *max_tokens == 0
                || *max_tokens > 32_768
                || provider.is_empty()
                || models.is_empty() =>
            {
                return Err(PermissionError::InvalidScope);
            }
            Self::Storage { collections, .. } if collections.is_empty() => {
                return Err(PermissionError::InvalidScope);
            }
            _ => {}
        }
        Ok(())
    }

    pub fn covers(&self, requested: &Self) -> bool {
        match (self, requested) {
            (
                Self::Storage {
                    synchronized: a,
                    write: b,
                    collections: c,
                },
                Self::Storage {
                    synchronized: x,
                    write: y,
                    collections: z,
                },
            ) => a == x && (!y || *b) && z.iter().all(|v| c.contains(v)),
            (
                Self::Network {
                    origin: a,
                    methods: b,
                    max_bytes: c,
                },
                Self::Network {
                    origin: x,
                    methods: y,
                    max_bytes: z,
                },
            ) => a == x && z <= c && y.iter().all(|v| b.contains(v)),
            (
                Self::File {
                    import: a,
                    media_types: b,
                    max_bytes: c,
                },
                Self::File {
                    import: x,
                    media_types: y,
                    max_bytes: z,
                },
            ) => a == x && z <= c && y.iter().all(|v| b.contains(v)),
            (
                Self::Ai {
                    provider: a,
                    models: b,
                    max_tokens: c,
                },
                Self::Ai {
                    provider: x,
                    models: y,
                    max_tokens: z,
                },
            ) => a == x && z <= c && y.iter().all(|v| b.contains(v)),
            _ => self == requested,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Grants {
    pub application: String,
    pub revision: String,
    pub capabilities: Vec<Capability>,
}

pub fn authorize(
    grants: &Grants,
    application: &str,
    revision: &str,
    request: &Capability,
) -> Result<(), PermissionError> {
    request.validate()?;
    if grants.application != application || grants.revision != revision {
        return Err(PermissionError::WrongApplication);
    }
    if grants
        .capabilities
        .iter()
        .any(|grant| grant.validate().is_ok() && grant.covers(request))
    {
        Ok(())
    } else {
        Err(PermissionError::Denied)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn denied_by_default_and_bound_to_revision() {
        let mut grants = Grants {
            application: "a".into(),
            revision: "r".into(),
            capabilities: vec![],
        };
        assert_eq!(
            authorize(&grants, "a", "r", &Capability::Share),
            Err(PermissionError::Denied)
        );
        grants.capabilities.push(Capability::Share);
        assert!(authorize(&grants, "a", "r", &Capability::Share).is_ok());
        assert_eq!(
            authorize(&grants, "b", "r", &Capability::Share),
            Err(PermissionError::WrongApplication)
        );
    }
    #[test]
    fn scope_broadening_is_not_authorized() {
        let grant = Capability::Network {
            origin: "https://example.com".into(),
            methods: vec!["GET".into()],
            max_bytes: 100,
        };
        assert!(grant.validate().is_ok());
        let request = Capability::Network {
            origin: "https://example.com".into(),
            methods: vec!["POST".into()],
            max_bytes: 100,
        };
        assert!(!grant.covers(&request));
        for origin in [
            "http://example.com",
            "https://localhost",
            "https://127.0.0.1",
            "https://example.com/path",
            "https://user@example.com",
        ] {
            assert!(
                Capability::Network {
                    origin: origin.into(),
                    methods: vec!["GET".into()],
                    max_bytes: 1
                }
                .validate()
                .is_err()
            );
        }
    }
}
