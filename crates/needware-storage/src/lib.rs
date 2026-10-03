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
    fn commit_revision(
        &mut self,
        application: &str,
        expected: u64,
        before: &State,
        after: &State,
    ) -> Result<u64, StorageError>;
    fn snapshot(&self, application: &str, generation: u64) -> Result<Option<State>, StorageError>;
}
#[cfg(feature = "native")]
pub struct SqliteStore(rusqlite::Connection);
#[cfg(feature = "native")]
impl SqliteStore {
    pub fn open(path: impl AsRef<std::path::Path>) -> Result<Self, StorageError> {
        let conn =
            rusqlite::Connection::open(path).map_err(|e| StorageError::Failure(e.to_string()))?;
        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| StorageError::Failure(e.to_string()))?;
        if version > 2 {
            return Err(StorageError::Failure("unsupported database version".into()));
        }
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS states(application TEXT PRIMARY KEY,generation INTEGER NOT NULL CHECK(generation>0),revision TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body))); CREATE TABLE IF NOT EXISTS revision_snapshots(application TEXT NOT NULL REFERENCES states(application) ON DELETE CASCADE,generation INTEGER NOT NULL,revision TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),PRIMARY KEY(application,generation)); PRAGMA user_version=2;").map_err(|e|StorageError::Failure(e.to_string()))?;
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
        let count=if expected==0 {tx.execute("INSERT INTO states(application,generation,revision,body) VALUES(?1,?2,?3,?4) ON CONFLICT DO NOTHING",rusqlite::params![application,generation as i64,state.revision,body])}else{tx.execute("UPDATE states SET generation=?2,body=?4 WHERE application=?1 AND generation=?5 AND revision=?3",rusqlite::params![application,generation as i64,state.revision,body,expected as i64])}.map_err(|e|StorageError::Failure(e.to_string()))?;
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
    fn snapshot(&self, application: &str, generation: u64) -> Result<Option<State>, StorageError> {
        use rusqlite::OptionalExtension;
        let generation = i64::try_from(generation).map_err(|_| StorageError::Conflict)?;
        let body: Option<String> = self
            .0
            .query_row(
                "SELECT body FROM revision_snapshots WHERE application=?1 AND generation=?2",
                rusqlite::params![application, generation],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| StorageError::Failure(e.to_string()))?;
        body.map(|body| {
            serde_json::from_str(&body).map_err(|e| StorageError::Failure(e.to_string()))
        })
        .transpose()
    }
    fn commit_revision(
        &mut self,
        application: &str,
        expected: u64,
        before: &State,
        after: &State,
    ) -> Result<u64, StorageError> {
        let generation = expected
            .checked_add(1)
            .filter(|n| *n <= i64::MAX as u64 && expected > 0)
            .ok_or(StorageError::Conflict)?;
        let old =
            serde_json::to_string(before).map_err(|e| StorageError::Failure(e.to_string()))?;
        let new = serde_json::to_string(after).map_err(|e| StorageError::Failure(e.to_string()))?;
        if old.len().max(new.len()) > 16 * 1024 * 1024 {
            return Err(StorageError::Failure("state size limit".into()));
        }
        let tx = self
            .0
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| StorageError::Failure(e.to_string()))?;
        let retained: i64 = tx.query_row("SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM revision_snapshots WHERE application=?1", [application], |r| r.get(0)).map_err(|e| StorageError::Failure(e.to_string()))?;
        if retained + old.len() as i64 > 128 * 1024 * 1024 {
            return Err(StorageError::Failure(
                "snapshot history full; export before removing history".into(),
            ));
        }
        let count = tx.execute("INSERT INTO revision_snapshots(application,generation,revision,body) SELECT application,generation,revision,body FROM states WHERE application=?1 AND generation=?2 AND body=?3", rusqlite::params![application, expected as i64, old]).map_err(|e| StorageError::Failure(e.to_string()))?;
        if count != 1 {
            return Err(StorageError::Conflict);
        }
        let count = tx.execute("UPDATE states SET generation=?2,revision=?3,body=?4 WHERE application=?1 AND generation=?5", rusqlite::params![application, generation as i64, after.revision, new, expected as i64]).map_err(|e| StorageError::Failure(e.to_string()))?;
        if count != 1 {
            return Err(StorageError::Conflict);
        }
        tx.commit()
            .map_err(|e| StorageError::Failure(e.to_string()))?;
        Ok(generation)
    }
}
#[cfg(all(test, feature = "native"))]
mod tests {
    use super::*;
    #[test]
    fn revision_snapshot_and_state_commit_or_fail_together()
    -> Result<(), Box<dyn std::error::Error>> {
        let mut store = SqliteStore::open(":memory:")?;
        let before = State {
            revision: "first".into(),
            values: Default::default(),
            collections: Default::default(),
        };
        let after = State {
            revision: "second".into(),
            ..before.clone()
        };
        store.commit("a", 0, &before)?;
        store.0.execute_batch("CREATE TRIGGER fail_revision BEFORE UPDATE ON states BEGIN SELECT RAISE(ABORT,'injected storage failure'); END;")?;
        assert!(store.commit_revision("a", 1, &before, &after).is_err());
        assert_eq!(store.snapshot("a", 1)?, None);
        assert_eq!(store.load("a")?, Some((1, before.clone())));
        store.0.execute_batch("DROP TRIGGER fail_revision;")?;
        assert!(matches!(
            store.commit_revision("a", 2, &before, &after),
            Err(StorageError::Conflict)
        ));
        assert!(matches!(
            store.commit_revision("a", 1, &after, &before),
            Err(StorageError::Conflict)
        ));
        assert_eq!(store.snapshot("a", 1)?, None);
        assert_eq!(store.commit_revision("a", 1, &before, &after)?, 2);
        assert_eq!(store.snapshot("a", 1)?, Some(before));
        assert_eq!(store.snapshot("b", 1)?, None);
        store.delete("a")?;
        assert_eq!(store.snapshot("a", 1)?, None);
        Ok(())
    }
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
