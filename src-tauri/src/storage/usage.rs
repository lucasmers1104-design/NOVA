//! Token usage of NOVA AI requests, for the usage display and monthly limits.

use rusqlite::{params, Connection};
use serde::Serialize;

use super::{now_millis, StorageError};

pub struct UsageRecord<'a> {
    pub provider: &'a str,
    pub model: &'a str,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Estimated US dollars × 1,000,000; `None` when the model's price is unknown.
    pub cost_micros: Option<i64>,
}

pub fn record(conn: &Connection, usage: &UsageRecord<'_>) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO ai_usage (at, provider, model, input_tokens, output_tokens, cost_micros) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![now_millis(), usage.provider, usage.model, usage.input_tokens as i64, usage.output_tokens as i64, usage.cost_micros],
    )?;
    Ok(())
}

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    pub requests: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    /// Sum of the estimates that exist.
    pub cost_micros: i64,
    /// Requests whose cost NOVA can't estimate.
    pub unpriced_requests: i64,
}

pub fn totals_since(conn: &Connection, since_ms: i64) -> Result<UsageTotals, StorageError> {
    Ok(conn.query_row(
        "SELECT count(*), coalesce(sum(input_tokens), 0), coalesce(sum(output_tokens), 0),
                coalesce(sum(cost_micros), 0), coalesce(sum(cost_micros IS NULL), 0)
         FROM ai_usage WHERE at >= ?1",
        [since_ms],
        |row| {
            Ok(UsageTotals {
                requests: row.get(0)?,
                input_tokens: row.get(1)?,
                output_tokens: row.get(2)?,
                cost_micros: row.get(3)?,
                unpriced_requests: row.get(4)?,
            })
        },
    )?)
}

pub fn clear(conn: &Connection) -> Result<(), StorageError> {
    conn.execute("DELETE FROM ai_usage", [])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sums_usage_and_counts_unpriced_requests() {
        let mut conn = Connection::open_in_memory().unwrap();
        super::super::migrations::migrate(&mut conn).unwrap();
        let base = UsageRecord { provider: "anthropic", model: "m", input_tokens: 1000, output_tokens: 200, cost_micros: Some(8000) };
        record(&conn, &base).unwrap();
        record(&conn, &UsageRecord { cost_micros: None, ..base }).unwrap();
        let totals = totals_since(&conn, 0).unwrap();
        assert_eq!(totals, UsageTotals { requests: 2, input_tokens: 2000, output_tokens: 400, cost_micros: 8000, unpriced_requests: 1 });
        assert_eq!(totals_since(&conn, now_millis() + 1000).unwrap().requests, 0);
    }
}
