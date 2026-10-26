/**
 * One account's page (0.34.0, spec 2026-10-26-desktop-0340 §B2), opened from its row as a delivery opens from
 * Deliveries: the trail back to its channel's list, the account itself, then About — the facts its row shows, and its
 * writing profile and sign-in — and Agents here, for every channel whose accounts act on other people. WhatsApp's only
 * drafts a link the person sends, so its page has About alone.
 *
 * The two views are a segmented control, not a second tab strip: the channel's tabs above are the page's one strip, and
 * the one that swipes. Both views stay mounted, so a preview waiting in Agents here is not revoked by a look at About.
 */
import { Avatar, Breadcrumb, Chip, Panel, SegmentedControl } from '@cueplusplus/ui';
import { type ReactNode, useState } from 'react';
import type { BehaviourReport, LabelReport } from '../../cli-types.ts';
import { UntrustedText } from '../../components/UntrustedText.tsx';
import { AgentsHere, type Read } from './AgentsHere.tsx';
import { isActing } from './acts.ts';

export const ACCOUNT_PAGE_COPY = {
  about: 'About',
  agentsHere: 'Agents here',
} as const;

/** What the page shows of the account at its head: what its row shows. */
export interface AccountHead {
  account: string;
  detail?: string | undefined;
  flag?: string | undefined;
  summary?: string | undefined;
}

type View = 'agents' | 'about';

export function AccountPage({
  channel,
  channelTitle,
  head,
  about,
  behaviour,
  label,
  onBack,
}: {
  channel: string;
  channelTitle: string;
  head: AccountHead;
  /** The About view: the account's facts and its own buttons, as the screen draws them. */
  about: ReactNode;
  behaviour: Read<BehaviourReport>;
  label: Read<LabelReport>;
  onBack: () => void;
}) {
  const [view, setView] = useState<View>('agents');
  return (
    <section aria-label={head.account} className="flex flex-col gap-(--cue-space-4)">
      <Breadcrumb
        label="Where you are"
        separator="›"
        items={[{ label: channelTitle, onClick: onBack }, { label: head.account }]}
      />
      <Panel className="flex items-start gap-(--cue-space-4) p-(--cue-space-5)">
        <span aria-hidden="true" className="flex shrink-0">
          <Avatar fallback={head.account.charAt(0)} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-(--cue-space-1)">
          <div className="flex flex-wrap items-center gap-x-(--cue-space-3) gap-y-(--cue-space-1)">
            <h2 className="font-semibold text-(length:--cue-text-title) text-fg">{head.account}</h2>
            {head.detail === undefined ? null : (
              <span className="text-fg-muted">
                <UntrustedText text={head.detail} />
              </span>
            )}
            {head.flag === undefined ? null : (
              <Chip tone="warn" variant="tag">
                {head.flag}
              </Chip>
            )}
          </div>
          {head.summary === undefined ? null : <p className="text-fg-muted">{head.summary}</p>}
        </div>
      </Panel>
      {isActing(channel) ? (
        <>
          <SegmentedControl
            indicator
            aria-label={`${head.account}: what to show`}
            className="self-start"
            items={[
              { value: 'about', label: ACCOUNT_PAGE_COPY.about },
              { value: 'agents', label: ACCOUNT_PAGE_COPY.agentsHere },
            ]}
            value={view}
            onValueChange={(value) => setView(value as View)}
          />
          <div hidden={view !== 'about'}>{about}</div>
          <div hidden={view !== 'agents'}>
            <AgentsHere channel={channel} account={head.account} behaviour={behaviour} label={label} />
          </div>
        </>
      ) : (
        about
      )}
    </section>
  );
}
