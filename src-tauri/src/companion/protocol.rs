//! NOVA Companion protocol v1, mirrored from `packages/companion-protocol/src/messages.ts`.
//! Both sides parse the same fixtures (tests below and `parse.test.ts`).
//!
//! SECURITY: everything from the phone is untrusted until `PhoneMessage::parse`
//! accepted it. Unknown types are refused, never guessed.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const VERSION: u32 = 1;
pub const MAX_TASK_CHARS: usize = 4000;
/// Everything the phone sends.
pub const MAX_SMALL_FRAME_BYTES: usize = 64 * 1024;

fn is_id(value: &str) -> bool {
    (1..=64).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// 32 bytes as unpadded base64url.
pub fn is_key32(value: &str) -> bool {
    value.len() == 43 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn is_nonce(value: &str) -> bool {
    value.len() == 22 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn check(ok: bool, why: &str) -> Result<(), String> {
    ok.then_some(()).ok_or_else(|| why.to_string())
}

// ---------------------------------------------------------------------------
// Handshake and pairing (plain JSON text frames)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Handshake {
    #[serde(rename = "hello", rename_all = "camelCase")]
    Hello { v: u32, device_id: String, eph_pub: String, nonce: String },
    #[serde(rename = "welcome", rename_all = "camelCase")]
    Welcome { v: u32, pc_id: String, eph_pub: String, nonce: String },
    #[serde(rename = "pair.request", rename_all = "camelCase")]
    PairRequest { v: u32, eph_pub: String, #[serde(rename = "box")] sealed: String },
    #[serde(rename = "pair.accepted")]
    PairAccepted { #[serde(rename = "box")] sealed: String },
    #[serde(rename = "pair.rejected")]
    PairRejected { reason: RejectReason },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RejectReason {
    Expired,
    Declined,
    Used,
    Busy,
    Invalid,
}

impl Handshake {
    pub fn parse(value: Value) -> Result<Self, String> {
        let message: Handshake = serde_json::from_value(value).map_err(|e| e.to_string())?;
        match &message {
            Handshake::Hello { v, device_id, eph_pub, nonce } => {
                check(*v == VERSION, "unsupported version")?;
                check(is_id(device_id) && is_key32(eph_pub) && is_nonce(nonce), "invalid hello")?;
            }
            Handshake::Welcome { v, pc_id, eph_pub, nonce } => {
                check(*v == VERSION, "unsupported version")?;
                check(is_id(pc_id) && is_key32(eph_pub) && is_nonce(nonce), "invalid welcome")?;
            }
            Handshake::PairRequest { v, eph_pub, sealed } => {
                check(*v == VERSION, "unsupported version")?;
                check(is_key32(eph_pub) && !sealed.is_empty() && sealed.len() <= 4000, "invalid pairing request")?;
            }
            Handshake::PairAccepted { sealed } => check(!sealed.is_empty() && sealed.len() <= 4000, "invalid box")?,
            Handshake::PairRejected { .. } => {}
        }
        Ok(message)
    }
}

/// Inside the sealed box of `pair.request`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairDetails {
    pub device_name: String,
    pub platform: Platform,
    pub device_pub: String,
    pub approval_key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Android,
    Ios,
}

impl Platform {
    pub fn as_str(self) -> &'static str {
        match self {
            Platform::Android => "android",
            Platform::Ios => "ios",
        }
    }
}

impl PairDetails {
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        let mut details: PairDetails = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
        details.device_name = details.device_name.trim().chars().filter(|c| !c.is_control()).collect();
        check(!details.device_name.is_empty() && details.device_name.chars().count() <= 60, "invalid device name")?;
        check(is_key32(&details.device_pub) && is_key32(&details.approval_key), "invalid keys")?;
        Ok(details)
    }
}

// ---------------------------------------------------------------------------
// From the phone (encrypted)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Schedule {
    Now,
    WhenOnline,
    At { date: String, time: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum PhoneMessage {
    #[serde(rename = "task.create", rename_all = "camelCase")]
    TaskCreate { id: String, ts: u64, text: String, voice: bool, want_screenshot: bool, schedule: Schedule },
    #[serde(rename = "task.cancel", rename_all = "camelCase")]
    TaskCancel { id: String, ts: u64, task_id: String },
    #[serde(rename = "approval.answer", rename_all = "camelCase")]
    ApprovalAnswer {
        id: String,
        ts: u64,
        request_id: String,
        approved: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        proof: Option<String>,
    },
    #[serde(rename = "status.get")]
    StatusGet { id: String, ts: u64 },
    #[serde(rename = "notices.get")]
    NoticesGet { id: String, ts: u64 },
    #[serde(rename = "notices.ack")]
    NoticesAck { id: String, ts: u64, ids: Vec<String> },
    #[serde(rename = "tasks.list")]
    TasksList { id: String, ts: u64 },
}

impl PhoneMessage {
    pub fn parse(value: Value) -> Result<Self, String> {
        let message: PhoneMessage = serde_json::from_value(value).map_err(|e| e.to_string())?;
        check(is_id(message.id()), "invalid id")?;
        match &message {
            PhoneMessage::TaskCreate { text, schedule, .. } => {
                check(!text.trim().is_empty() && text.chars().count() <= MAX_TASK_CHARS, "invalid text")?;
                if let Schedule::At { date, time } = schedule {
                    check(super::queue::day_number(date).is_some() && super::queue::minutes_of(time).is_some(), "invalid schedule")?;
                }
            }
            PhoneMessage::TaskCancel { task_id, .. } => check(is_id(task_id), "invalid task id")?,
            PhoneMessage::ApprovalAnswer { request_id, approved, proof, .. } => {
                check(is_id(request_id), "invalid request id")?;
                // SECURITY: an approval without its biometric-bound proof is never accepted.
                if *approved {
                    check(proof.as_deref().is_some_and(is_key32), "approval without proof")?;
                }
            }
            PhoneMessage::NoticesAck { ids, .. } => check(ids.len() <= 100 && ids.iter().all(|i| is_id(i)), "invalid ids")?,
            PhoneMessage::StatusGet { .. } | PhoneMessage::NoticesGet { .. } | PhoneMessage::TasksList { .. } => {}
        }
        Ok(message)
    }

    pub fn id(&self) -> &str {
        match self {
            PhoneMessage::TaskCreate { id, .. }
            | PhoneMessage::TaskCancel { id, .. }
            | PhoneMessage::ApprovalAnswer { id, .. }
            | PhoneMessage::StatusGet { id, .. }
            | PhoneMessage::NoticesGet { id, .. }
            | PhoneMessage::NoticesAck { id, .. }
            | PhoneMessage::TasksList { id, .. } => id,
        }
    }
}

// ---------------------------------------------------------------------------
// To the phone (encrypted)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Free,
    Approve,
    Never,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskState {
    Queued,
    Scheduled,
    Running,
    Done,
    Failed,
    Cancelled,
    Missed,
}

impl TaskState {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskState::Queued => "queued",
            TaskState::Scheduled => "scheduled",
            TaskState::Running => "running",
            TaskState::Done => "done",
            TaskState::Failed => "failed",
            TaskState::Cancelled => "cancelled",
            TaskState::Missed => "missed",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        serde_json::from_value(Value::String(value.into())).ok()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Media {
    pub title: String,
    pub artist: String,
    pub playing: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum TaskEventBody {
    Accepted {
        state: TaskState,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        run_at: Option<String>,
    },
    Status {
        /// The agent's `Status`, already camelCase.
        state: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    Text { text: String },
    ToolStarted { tool_id: String, title: String, tier: Tier },
    ToolFinished { tool_id: String, ok: bool, summary: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Screenshot {
    pub mime: String,
    pub width: u32,
    pub height: u32,
    pub data: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    Safe,
    Confirm,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Approved,
    Declined,
    Expired,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoticeKind {
    Watch,
    TaskDone,
    TaskFailed,
    TaskMissed,
    CheckStopped,
}

impl NoticeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            NoticeKind::Watch => "watch",
            NoticeKind::TaskDone => "taskDone",
            NoticeKind::TaskFailed => "taskFailed",
            NoticeKind::TaskMissed => "taskMissed",
            NoticeKind::CheckStopped => "checkStopped",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub id: String,
    pub kind: NoticeKind,
    pub text: String,
    pub task_id: Option<String>,
    pub ts: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    pub task_id: String,
    pub text: String,
    pub state: TaskState,
    pub run_at: Option<String>,
    pub created_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    Invalid,
    Busy,
    UnknownTask,
    UnknownRequest,
    Expired,
    BadProof,
    NotAllowed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum PcMessage {
    #[serde(rename = "status", rename_all = "camelCase")]
    Status {
        id: String,
        ts: u64,
        pc_name: String,
        busy: bool,
        ai_ready: bool,
        in_game: bool,
        // Required, though it may be null.
        #[serde(deserialize_with = "Option::deserialize")]
        media: Option<Media>,
        pending_approvals: u32,
        active_tasks: u32,
    },
    #[serde(rename = "task.event", rename_all = "camelCase")]
    TaskEvent { id: String, ts: u64, task_id: String, event: TaskEventBody },
    #[serde(rename = "task.result", rename_all = "camelCase")]
    TaskResult { id: String, ts: u64, task_id: String, ok: bool, text: String, screenshot: Option<Screenshot>, error: Option<String> },
    #[serde(rename = "approval.request", rename_all = "camelCase")]
    ApprovalRequest { id: String, ts: u64, request_id: String, task_id: String, title: String, detail: Option<String>, risk: Risk, expires_at: u64 },
    #[serde(rename = "approval.closed", rename_all = "camelCase")]
    ApprovalClosed { id: String, ts: u64, request_id: String, outcome: Outcome },
    #[serde(rename = "notices")]
    Notices { id: String, ts: u64, items: Vec<Notice> },
    #[serde(rename = "tasks")]
    Tasks { id: String, ts: u64, items: Vec<TaskSummary> },
    #[serde(rename = "error", rename_all = "camelCase")]
    Error { id: String, ts: u64, code: ErrorCode, message: String, reply_to: Option<String> },
    #[serde(rename = "device.revoked")]
    DeviceRevoked { id: String, ts: u64 },
}

/// A fresh message id: 16 random bytes, base64url.
pub fn new_id() -> String {
    super::crypto::b64(&super::crypto::random::<16>())
}

pub fn now() -> u64 {
    crate::storage::now_millis().max(0) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixtures(name: &str) -> Vec<Value> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages/companion-protocol/fixtures").join(name);
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn phone_fixtures_parse_like_typescript() {
        for message in fixtures("phone-valid.json") {
            let parsed = PhoneMessage::parse(message.clone()).unwrap_or_else(|e| panic!("{message}: {e}"));
            assert_eq!(serde_json::to_value(&parsed).unwrap(), message);
        }
        for message in fixtures("phone-invalid.json") {
            assert!(PhoneMessage::parse(message.clone()).is_err(), "accepted {message}");
        }
    }

    #[test]
    fn pc_messages_serialize_exactly_like_the_fixtures() {
        for message in fixtures("pc-valid.json") {
            let parsed: PcMessage = serde_json::from_value(message.clone()).unwrap_or_else(|e| panic!("{message}: {e}"));
            assert_eq!(serde_json::to_value(&parsed).unwrap(), message);
        }
        for message in fixtures("pc-invalid.json") {
            assert!(serde_json::from_value::<PcMessage>(message.clone()).is_err(), "accepted {message}");
        }
    }

    #[test]
    fn handshake_fixtures_parse_like_typescript() {
        for message in fixtures("handshake-valid.json") {
            let parsed = Handshake::parse(message.clone()).unwrap_or_else(|e| panic!("{message}: {e}"));
            assert_eq!(serde_json::to_value(&parsed).unwrap(), message);
        }
        for message in fixtures("handshake-invalid.json") {
            assert!(Handshake::parse(message.clone()).is_err(), "accepted {message}");
        }
    }

    #[test]
    fn pair_details_are_checked() {
        let key = "A".repeat(43);
        let ok = format!(r#"{{"deviceName":" Pixel 9 ","platform":"android","devicePub":"{key}","approvalKey":"{key}"}}"#);
        assert_eq!(PairDetails::parse(ok.as_bytes()).unwrap().device_name, "Pixel 9");
        let bad = format!(r#"{{"deviceName":"","platform":"android","devicePub":"{key}","approvalKey":"{key}"}}"#);
        assert!(PairDetails::parse(bad.as_bytes()).is_err());
        let bad = format!(r#"{{"deviceName":"x","platform":"android","devicePub":"short","approvalKey":"{key}"}}"#);
        assert!(PairDetails::parse(bad.as_bytes()).is_err());
    }
}
