//! The build consumes B3's data-only schema, registry and vectors. Open JSON remains opaque.
use super::types::ControlError;
use serde_json::Value;
use std::collections::BTreeMap;

#[allow(clippy::all, unused_parens)]
mod generated {
    include!(concat!(env!("OUT_DIR"), "/b3_generated.rs"));
}
pub use generated::{
    NonSecretOperation, B3_SCHEMA_DIGEST, NON_SECRET_OPERATIONS, SECRET_OPERATIONS,
};

#[derive(Clone, Debug)]
pub struct B3Request(generated::RequestDto);

impl<'de> serde::Deserialize<'de> for B3Request {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = <Value as serde::Deserialize>::deserialize(deserializer)?;
        Self::parse(value).map_err(|error| serde::de::Error::custom(error.code))
    }
}

#[derive(Debug)]
pub struct B3Reply {
    pub operation: NonSecretOperation,
    data: generated::ResultDto,
}
impl B3Reply {
    pub(crate) fn checked_value(&self) -> Value {
        serde_json::to_value(&self.data).expect("generated B3 DTO is serializable")
    }
    pub(crate) fn safe_boundary_value(self) -> Value {
        serde_json::to_value(self.data).expect("generated B3 DTO is serializable")
    }
}

impl B3Request {
    pub fn parse(value: Value) -> Result<Self, ControlError> {
        if value
            .get("operation")
            .and_then(Value::as_str)
            .is_some_and(|op| SECRET_OPERATIONS.contains(&op))
        {
            return Err(ControlError::new(
                "APP_SECRET_CAPABILITY_UNAVAILABLE",
                "secret operations require a separate capability",
            ));
        }
        let dto: generated::RequestDto = serde_json::from_value(value.clone())
            .map_err(|_| ControlError::new("B3_REQUEST_SCHEMA", "invalid B3 request"))?;
        if !dto.valid_args(&value["args"]) {
            return Err(ControlError::new(
                "B3_REQUEST_SCHEMA",
                "invalid B3 request arguments",
            ));
        }
        Ok(Self(dto))
    }
    pub fn operation(&self) -> NonSecretOperation {
        self.0.operation()
    }
    pub fn args(&self) -> Value {
        serde_json::to_value(&self.0).unwrap()["args"].clone()
    }
    pub fn scope_fields(&self) -> &'static [&'static str] {
        self.0.scope_fields()
    }
    /// The renderer cannot choose a scope: these identities are derived only from the schema-validated request.
    pub fn expected_scope(&self) -> BTreeMap<String, Value> {
        let args = self.args();
        let mut scope = BTreeMap::new();
        for field in [
            "id",
            "objectId",
            "type",
            "version",
            "source",
            "accountId",
            "ruleId",
            "ruleVersion",
            "targetId",
            "targetVersion",
            "subscriberId",
            "deliveryId",
            "eventId",
            "judgeId",
            "budgetId",
        ] {
            if let Some(value) = args.get(field).filter(is_scope_value) {
                scope.insert(field.to_owned(), value.clone());
            }
        }
        let Some(document) = args.get("document").and_then(Value::as_object) else {
            return scope;
        };
        for field in ["ruleId", "targetId", "subscriberId", "judgeId", "budgetId"] {
            if let Some(value) = document.get(field).filter(is_scope_value) {
                scope.insert("objectId".into(), value.clone());
                scope.insert(format!("document.{field}"), value.clone());
                break;
            }
        }
        if let Some(value) = document.get("version").filter(is_scope_value) {
            scope.insert("version".into(), value.clone());
            scope.insert("document.version".into(), value.clone());
        }
        if let Some(source) = document.get("source").and_then(Value::as_object) {
            for field in ["channel", "accountIds"] {
                if let Some(value) = source.get(field).filter(is_scope_value) {
                    scope.insert(format!("document.source.{field}"), value.clone());
                }
            }
        }
        scope
    }
    /// A stored-version reply must carry precisely the requested immutable document and matching root identity.
    pub fn result_matches_request_scope(&self, result: &Value) -> bool {
        let args = self.args();
        if self.scope_fields().iter().any(|field| {
            args.get(*field)
                .is_some_and(|expected| result.get(*field) != Some(expected))
        }) {
            return false;
        }
        let Some(document) = args.get("document") else {
            return true;
        };
        // Typed pre-E unavailable responses are not object records and therefore cannot paint an object identity.
        let Some(reply_document) = result.get("document") else {
            return true;
        };
        if reply_document != document {
            return false;
        }
        let Some(document) = document.as_object() else {
            return false;
        };
        let id = ["ruleId", "targetId", "subscriberId", "judgeId", "budgetId"]
            .iter()
            .find_map(|field| document.get(*field));
        id.is_none_or(|expected| result.get("objectId") == Some(expected))
            && document
                .get("version")
                .is_none_or(|expected| result.get("version") == Some(expected))
    }
    pub fn result(&self, value: Value) -> Result<B3Reply, ControlError> {
        let data = self
            .0
            .parse_result(value)
            .map_err(|code| ControlError::new(code, "invalid B3 result"))?;
        Ok(B3Reply {
            operation: self.operation(),
            data,
        })
    }
    pub fn generic_dispatch_allowed(&self) -> Result<(), ControlError> {
        if matches!(
            self.operation(),
            NonSecretOperation::Approve | NonSecretOperation::ApprovalView
        ) {
            return Err(ControlError::new(
                "APPROVAL_SCREEN_REQUIRED",
                "approval requires its native command",
            ));
        }
        Ok(())
    }
}

fn is_scope_value(value: &&Value) -> bool {
    value.is_string()
        || value.is_number()
        || value
            .as_array()
            .is_some_and(|values| values.iter().all(Value::is_string))
}
