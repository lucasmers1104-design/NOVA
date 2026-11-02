//! NOVA AI conversation history.

use rusqlite::{params, Connection, Row};
use serde::Serialize;

use super::{is_identifier, new_id, now_millis, StorageError};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub provider: String,
    pub model: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub role: String,
    pub content: String,
    pub error: Option<String>,
    pub created_at: i64,
}

fn conversation_from_row(r: &Row) -> rusqlite::Result<Conversation> {
    Ok(Conversation {
        id: r.get(0)?,
        title: r.get(1)?,
        provider: r.get(2)?,
        model: r.get(3)?,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
    })
}

pub fn list(conn: &mut Connection) -> Result<Vec<Conversation>, StorageError> {
    Ok(conn
        .prepare("SELECT id, title, provider, model, created_at, updated_at FROM ai_conversations ORDER BY updated_at DESC")?
        .query_map([], conversation_from_row)?
        .collect::<Result<_, _>>()?)
}

pub fn get(conn: &mut Connection, id: &str) -> Result<Conversation, StorageError> {
    conn.query_row(
        "SELECT id, title, provider, model, created_at, updated_at FROM ai_conversations WHERE id = ?1",
        [id],
        conversation_from_row,
    )
    .map_err(|_| StorageError::Invalid("Conversation not found".into()))
}

pub fn create(conn: &mut Connection, title: &str, provider: &str, model: &str) -> Result<Conversation, StorageError> {
    let now = now_millis();
    let conversation = Conversation {
        id: new_id("chat"),
        title: title.chars().take(80).collect::<String>().trim().to_string(),
        provider: provider.to_string(),
        model: model.to_string(),
        created_at: now,
        updated_at: now,
    };
    conn.execute(
        "INSERT INTO ai_conversations (id, title, provider, model, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![conversation.id, conversation.title, conversation.provider, conversation.model, now],
    )?;
    Ok(conversation)
}

pub fn update_model(conn: &mut Connection, id: &str, provider: &str, model: &str) -> Result<(), StorageError> {
    conn.execute(
        "UPDATE ai_conversations SET provider = ?2, model = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, provider, model, now_millis()],
    )?;
    Ok(())
}

pub fn rename(conn: &mut Connection, id: &str, title: &str) -> Result<(), StorageError> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 80 {
        return Err(StorageError::Invalid("Title must be 1–80 characters".into()));
    }
    conn.execute("UPDATE ai_conversations SET title = ?2 WHERE id = ?1", params![id, title])?;
    Ok(())
}

pub fn delete(conn: &mut Connection, id: &str) -> Result<(), StorageError> {
    if !is_identifier(id, 64) {
        return Err(StorageError::Invalid("invalid conversation id".into()));
    }
    conn.execute("DELETE FROM ai_conversations WHERE id = ?1", [id])?;
    Ok(())
}

pub fn messages(conn: &mut Connection, conversation_id: &str) -> Result<Vec<Message>, StorageError> {
    Ok(conn
        .prepare("SELECT id, role, content, error, created_at FROM ai_messages WHERE conversation_id = ?1 ORDER BY created_at, rowid")?
        .query_map([conversation_id], |r| {
            Ok(Message { id: r.get(0)?, role: r.get(1)?, content: r.get(2)?, error: r.get(3)?, created_at: r.get(4)? })
        })?
        .collect::<Result<_, _>>()?)
}

pub fn add_message(
    conn: &mut Connection,
    conversation_id: &str,
    role: &str,
    content: &str,
    error: Option<&str>,
) -> Result<Message, StorageError> {
    let now = now_millis();
    let message = Message {
        id: new_id("msg"),
        role: role.to_string(),
        content: content.to_string(),
        error: error.map(str::to_string),
        created_at: now,
    };
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO ai_messages (id, conversation_id, role, content, error, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![message.id, conversation_id, message.role, message.content, message.error, now],
    )?;
    tx.execute("UPDATE ai_conversations SET updated_at = ?2 WHERE id = ?1", params![conversation_id, now])?;
    tx.commit()?;
    Ok(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_connection;

    #[test]
    fn stores_conversations_with_ordered_messages() {
        let mut conn = test_connection();
        let chat = create(&mut conn, "Trip ideas", "anthropic", "claude-sonnet-5-5").unwrap();
        add_message(&mut conn, &chat.id, "user", "Where should I go?", None).unwrap();
        add_message(&mut conn, &chat.id, "assistant", "Lisbon.", None).unwrap();
        let history = messages(&mut conn, &chat.id).unwrap();
        assert_eq!(history.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(), ["user", "assistant"]);
        assert_eq!(list(&mut conn).unwrap()[0].id, chat.id);

        delete(&mut conn, &chat.id).unwrap();
        assert!(messages(&mut conn, &chat.id).unwrap().is_empty());
    }

    #[test]
    fn rejects_invalid_roles() {
        let mut conn = test_connection();
        let chat = create(&mut conn, "x", "openai", "m").unwrap();
        assert!(add_message(&mut conn, &chat.id, "system", "hi", None).is_err());
    }
}
