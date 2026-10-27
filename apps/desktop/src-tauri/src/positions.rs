//! Where the designer keeps each workflow's boxes (0.36.0, workflows design W20, §11.3, Q13): a box's place on the
//! canvas, by workflow id and box id, in `<app_config_dir>/workflow-positions.json`, beside Settings' `settings.json`.
//!
//! They are the app's own convenience and never part of what is approved: nothing here reaches the event service or a
//! CLI, a position changes no workflow's bytes, and Approve… lays the graph out afresh. The window may only keep
//! numbers under names the grammar allows — a workflow's id, and a step's id or one of the gate's four boxes — so the
//! file can hold nothing else. A file the app cannot read is no positions, and a box past the bounds is refused.

use crate::allowlist::RuleId;
use crate::grammar;
use crate::ipc::AppError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

/// The file's name, in the app's config folder.
pub const FILE: &str = "workflow-positions.json";

/// The most workflows the file keeps: past it, the first by id is dropped, never the one just written.
const WORKFLOWS_MAX: usize = 500;

/// The most boxes one workflow keeps: its 32 steps (spec W4) and the gate's four, with room for a draft.
const BOXES_MAX: usize = 64;

/// How far from the origin a box may be, either way, in the canvas's units.
const COORDINATE_LIMIT: f64 = 1_000_000.0;

/// The gate's boxes, which no step id can be: a step id has no `:`.
const GATE_BOXES: [&str; 4] = ["gate:trigger", "gate:condition", "gate:judge", "gate:keep"];

/// The ids no step may take (spec §4.1, `RESERVED_STEP_IDS`).
const RESERVED_STEP_IDS: [&str; 4] = ["run", "trigger", "end", "otherwise"];

/// One box's place.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// A workflow's boxes, by id.
pub type Positions = BTreeMap<String, Point>;

#[derive(Default, Serialize, Deserialize)]
struct PositionsFile {
    #[serde(default)]
    workflows: BTreeMap<String, Positions>,
}

/// Whether `id` names a box: a step's id, or one of the gate's.
fn box_id(id: &str) -> bool {
    (grammar::step_id(id) && !RESERVED_STEP_IDS.contains(&id)) || GATE_BOXES.contains(&id)
}

/// `positions`, once every box has a name the grammar allows and a place inside the bounds, and there are not too many.
pub fn validate(positions: Positions) -> Result<Positions, AppError> {
    if positions.len() > BOXES_MAX {
        return Err(AppError::refused(format!(
            "a workflow keeps at most {BOXES_MAX} boxes' places"
        )));
    }
    for (id, point) in &positions {
        if !box_id(id) {
            return Err(AppError::refused("that is not a step's or the gate's box"));
        }
        let inside = |value: f64| value.is_finite() && value.abs() <= COORDINATE_LIMIT;
        if !inside(point.x) || !inside(point.y) {
            return Err(AppError::refused("a box's place is a number on the canvas"));
        }
    }
    Ok(positions)
}

fn read(dir: &Path) -> PositionsFile {
    let Ok(text) = fs::read_to_string(dir.join(FILE)) else {
        return PositionsFile::default();
    };
    serde_json::from_str::<PositionsFile>(&text).unwrap_or_default()
}

/// The boxes kept for `rule_id` in `dir`: none when there is no file, the app cannot read it, or a box in it is not one
/// `validate` takes.
pub fn load(dir: &Path, rule_id: &RuleId) -> Positions {
    read(dir)
        .workflows
        .remove(rule_id.as_str())
        .and_then(|positions| validate(positions).ok())
        .unwrap_or_default()
}

/// Keeps `positions` for `rule_id` in `dir`, making the folder if it is missing. An empty map forgets the workflow. The
/// file is written beside its place, then moved there, so a reader never sees half of it.
pub fn save(dir: &Path, rule_id: &RuleId, positions: Positions) -> Result<(), AppError> {
    let positions = validate(positions)?;
    let failed = |error: std::io::Error| {
        AppError::io(format!(
            "the workflow's layout could not be kept in {}: {error}",
            dir.display()
        ))
    };
    fs::create_dir_all(dir).map_err(failed)?;
    let mut file = read(dir);
    file.workflows
        .retain(|id, kept| grammar::rule_id(id) && validate(kept.clone()).is_ok());
    if positions.is_empty() {
        file.workflows.remove(rule_id.as_str());
    } else {
        file.workflows
            .insert(rule_id.as_str().to_string(), positions);
    }
    while file.workflows.len() > WORKFLOWS_MAX {
        let oldest = file
            .workflows
            .keys()
            .find(|id| id.as_str() != rule_id.as_str())
            .cloned();
        match oldest {
            Some(id) => file.workflows.remove(&id),
            None => break,
        };
    }
    let mut text = serde_json::to_string_pretty(&file)
        .map_err(|error| AppError::io(format!("the layout could not be written: {error}")))?;
    text.push('\n');
    let temporary = dir.join(format!("{FILE}.{}.tmp", std::process::id()));
    fs::write(&temporary, text).map_err(failed)?;
    fs::rename(&temporary, dir.join(FILE)).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        failed(error)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(id: &str) -> RuleId {
        RuleId::try_from(id.to_string()).expect("a rule id")
    }

    fn point(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    fn temporary_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agentcomms-positions-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn positions_round_trip_by_workflow_and_box() {
        let dir = temporary_dir("round-trip");
        let mut kept = Positions::new();
        kept.insert("find".to_string(), point(10.0, -20.5));
        kept.insert("gate:keep".to_string(), point(0.0, 0.0));
        save(&dir, &rule("client-asks"), kept.clone()).expect("saved");
        let mut other = Positions::new();
        other.insert("deliver-log".to_string(), point(5.0, 5.0));
        save(&dir, &rule("invoices"), other.clone()).expect("saved");
        assert_eq!(load(&dir, &rule("client-asks")), kept);
        assert_eq!(load(&dir, &rule("invoices")), other);
        assert_eq!(load(&dir, &rule("nothing-kept")), Positions::new());
        save(&dir, &rule("invoices"), Positions::new()).expect("forgotten");
        assert_eq!(load(&dir, &rule("invoices")), Positions::new());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_box_is_a_step_or_the_gate_and_its_place_a_number_in_bounds() {
        for id in ["Find", "run", "gate:other", "../x", "a b", ""] {
            let mut positions = Positions::new();
            positions.insert(id.to_string(), point(0.0, 0.0));
            assert!(validate(positions).is_err(), "{id} is refused");
        }
        for value in [f64::NAN, f64::INFINITY, 2_000_000.0] {
            let mut positions = Positions::new();
            positions.insert("find".to_string(), point(value, 0.0));
            assert!(validate(positions).is_err(), "{value} is refused");
        }
        let many: Positions = (0..65)
            .map(|index| (format!("step-{index}"), point(0.0, 0.0)))
            .collect();
        assert!(validate(many).is_err());
    }

    #[test]
    fn a_file_the_app_cannot_read_is_no_positions() {
        let dir = temporary_dir("unreadable");
        fs::create_dir_all(&dir).expect("a folder");
        fs::write(dir.join(FILE), "{ not json").expect("written");
        assert_eq!(load(&dir, &rule("client-asks")), Positions::new());
        fs::write(
            dir.join(FILE),
            r#"{"workflows":{"client-asks":{"Bad Box":{"x":1,"y":2}}}}"#,
        )
        .expect("written");
        assert_eq!(load(&dir, &rule("client-asks")), Positions::new());
        let _ = fs::remove_dir_all(&dir);
    }
}
