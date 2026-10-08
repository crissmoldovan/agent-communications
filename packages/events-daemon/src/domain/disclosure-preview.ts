import {
  type ActivationDocumentV1,
  canonicalActivationDocument,
  disclosureBindingFor,
} from './activation-documents.ts';

export interface DisclosurePreview {
  readonly activationIntentId: string;
  readonly activationKind: ActivationDocumentV1['kind'];
  readonly digest: string;
  readonly versions: ReturnType<typeof disclosureBindingFor>['versions'];
  /** Structured canonical data. A CLI/app surface must still render every string through its untrusted-safe renderer. */
  readonly canonicalDocument: string;
}

/** Creates a data-only preview from canonical authority bytes; it never accepts a second version list or trusted markup. */
export function disclosurePreviewFor(activationIntentId: string, document: ActivationDocumentV1): DisclosurePreview {
  const binding = disclosureBindingFor(activationIntentId, document);
  return {
    activationIntentId: binding.activationIntentId,
    activationKind: binding.activationKind,
    digest: binding.digest,
    versions: binding.versions,
    canonicalDocument: canonicalActivationDocument(document),
  };
}
