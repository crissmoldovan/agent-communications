import { Spinner } from '@cueplusplus/ui';
import type { ReactNode } from 'react';
import { COPY } from '../copy.ts';
import type { Loadable } from '../data.tsx';
import { UntrustedText } from './UntrustedText.tsx';

/** Shows what a read came to: a spinner while it loads, what went wrong, or its value through `children`. */
export function ScreenState<T>({ value, children }: { value: Loadable<T>; children: (value: T) => ReactNode }) {
  switch (value.state) {
    case 'loading':
      return <Spinner label={COPY.loading} />;
    case 'error':
      return (
        <p role="alert" className="text-danger">
          <UntrustedText text={value.message} />
        </p>
      );
    case 'ready':
      return <>{children(value.value)}</>;
  }
}
