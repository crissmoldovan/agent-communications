/** The closed service declaration read from a package's `agentcommsPackage` field. */
export interface ServiceDeclaration {
  kind: 'service';
  binary: string;
  server: {
    defaultName: string;
    entry: string;
    factory: string;
  };
  operations: string;
  skills?: {
    prefix: string;
    contract: string;
  };
}

/** What core needs from a declared service at runtime. */
export interface ServiceEntry {
  packageName: string;
  declaration: ServiceDeclaration;
}
