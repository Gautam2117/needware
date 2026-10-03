//! Compare-and-swap persistence isolates applications and detects stale writers.
use needware_ir::State;
use thiserror::Error;
#[derive(Debug, Error)]
pub enum StorageError {
    #[error("state changed in another writer")]
    Conflict,
    #[error("storage operation failed: {0}")]
    Failure(String),
}
pub trait Store {
    fn load(&self, application: &str) -> Result<Option<(u64, State)>, StorageError>;
    fn commit(
        &mut self,
        application: &str,
        expected: u64,
        state: &State,
    ) -> Result<u64, StorageError>;
    fn delete(&mut self, application: &str) -> Result<(), StorageError>;
}
#[cfg(feature = "native")]
pub struct SqliteStore(rusqlite::Connection);
#[cfg(feature = "native")]
impl SqliteStore {
    pub fn open(path: impl AsRef<std::path::Path>) -> Result<Self, StorageError> {
        let conn =
            rusqlite::Connection::open(path).map_err(|e| StorageError::Failure(e.to_string()))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS states(application TEXT PRIMARY KEY,generation INTEGER NOT NULL CHECK(generation>0),revision TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body))); PRAGMA user_version=1;").map_err(|e|StorageError::Failure(e.to_string()))?;
        Ok(Self(conn))
    }
}
#[cfg(feature = "native")]
impl Store for SqliteStore {
    fn load(&self, application: &str) -> Result<Option<(u64, State)>, StorageError> {
        use rusqlite::OptionalExtension;
        let row: Option<(i64, String)> = self
            .0
            .query_row(
                "SELECT generation,body FROM states WHERE application=?1",
                [application],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| StorageError::Failure(e.to_string()))?;
        row.map(|(generation, body)| {
            serde_json::from_str(&body)
                .map(|state| (generation as u64, state))
                .map_err(|e| StorageError::Failure(e.to_string()))
        })
        .transpose()
    }
    fn commit(
        &mut self,
        application: &str,
        expected: u64,
        state: &State,
    ) -> Result<u64, StorageError> {
        let generation = expected
            .checked_add(1)
            .filter(|n| *n <= i64::MAX as u64)
            .ok_or(StorageError::Conflict)?;
        let body =
            serde_json::to_string(state).map_err(|e| StorageError::Failure(e.to_string()))?;
        if body.len() > 16 * 1024 * 1024 {
            return Err(StorageError::Failure("state size limit".into()));
        }
        let tx = self
            .0
            .transaction()
            .map_err(|e| StorageError::Failure(e.to_string()))?;
        let count=if expected==0 {tx.execute("INSERT INTO states(application,generation,revision,body) VALUES(?1,?2,?3,?4) ON CONFLICT DO NOTHING",rusqlite::params![application,generation as i64,state.revision,body])}else{tx.execute("UPDATE states SET generation=?2,revision=?3,body=?4 WHERE application=?1 AND generation=?5",rusqlite::params![application,generation as i64,state.revision,body,expected as i64])}.map_err(|e|StorageError::Failure(e.to_string()))?;
        if count != 1 {
            return Err(StorageError::Conflict);
        }
        tx.commit()
            .map_err(|e| StorageError::Failure(e.to_string()))?;
        Ok(generation)
    }
    fn delete(&mut self, application: &str) -> Result<(), StorageError> {
        self.0
            .execute("DELETE FROM states WHERE application=?1", [application])
            .map_err(|e| StorageError::Failure(e.to_string()))?;
        Ok(())
    }
}
#[cfg(all(test, feature = "native"))]
mod tests {
    use super::*;
    #[test]
    fn reopening_isolated_state_and_stale_writes() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("state.sqlite");
        let state = State {
            revision: "r".into(),
            values: Default::default(),
            collections: Default::default(),
        };
        {
            let mut store = SqliteStore::open(&path)?;
            assert_eq!(store.commit("a", 0, &state)?, 1);
            assert!(matches!(
                store.commit("a", 0, &state),
                Err(StorageError::Conflict)
            ));
            assert!(store.load("b")?.is_none());
        }
        let mut store = SqliteStore::open(&path)?;
        assert_eq!(store.load("a")?.map(|r| r.0), Some(1));
        store.delete("a")?;
        assert!(store.load("a")?.is_none());
        Ok(())
    }
}
