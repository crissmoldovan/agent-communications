/**
 * Workflows in the sidebar (workflows design §11.2, the approved prototype's sidebar): the Events screen, opened on its
 * Workflows tab — the one list of every workflow, straight line or graph. It is not a screen of its own, so a workflow
 * is found, edited and approved in the one place whichever way the person came.
 */
import { useState } from 'react';
import type { Screen } from '../../copy.ts';
import { askFor } from '../../navigation.tsx';
import { Events } from '../Events.tsx';

export function Workflows({ onScreen }: { onScreen: (screen: Screen) => void }) {
  // Asked for before Events reads where to open, which it does as it mounts.
  useState(() => askFor({ screen: 'events', tab: 'rules' }));
  return <Events onScreen={onScreen} />;
}
