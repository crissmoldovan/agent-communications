use super::types::ControlError;
use serde_json::Value;

pub const MAX_FRAME_BYTES: usize = 64 * 1024;
pub const SUPPORTED: [u32; 1] = [1];

pub fn encode_frame(value: &Value) -> Result<Vec<u8>, ControlError> {
    let json = serde_json::to_vec(value)
        .map_err(|_| ControlError::new("MALFORMED_FRAME", "cannot encode frame"))?;
    if json.len() > MAX_FRAME_BYTES {
        return Err(ControlError::new(
            "FRAME_TOO_LARGE",
            "frame exceeds protocol limit",
        ));
    }
    let mut frame = Vec::with_capacity(4 + json.len());
    frame.extend_from_slice(&(json.len() as u32).to_be_bytes());
    frame.extend_from_slice(&json);
    Ok(frame)
}

pub fn decode_frame(frame: &[u8]) -> Result<Value, ControlError> {
    if frame.len() < 4 {
        return Err(ControlError::new("MALFORMED_FRAME", "missing frame prefix"));
    }
    let length = u32::from_be_bytes(
        frame[..4]
            .try_into()
            .map_err(|_| ControlError::new("MALFORMED_FRAME", "bad prefix"))?,
    ) as usize;
    if length > MAX_FRAME_BYTES {
        return Err(ControlError::new(
            "FRAME_TOO_LARGE",
            "frame exceeds protocol limit",
        ));
    }
    if length != frame.len() - 4 {
        return Err(ControlError::new(
            "MALFORMED_FRAME",
            "frame length mismatch",
        ));
    }
    serde_json::from_slice(&frame[4..])
        .map_err(|_| ControlError::new("MALFORMED_FRAME", "invalid frame JSON"))
}

pub fn select_version(client: &[u32], server: &[u32]) -> Result<u32, ControlError> {
    client
        .iter()
        .copied()
        .filter(|v| server.contains(v))
        .max()
        .ok_or_else(|| ControlError::new("PROTOCOL_UNSUPPORTED", "no mutual control version"))
}
