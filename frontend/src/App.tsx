import { ERCV6Panel } from './components/ERCV6Panel';
import { useEffect } from 'react';
import { MapView } from './map/MapView';
import { TopBar } from './components/TopBar';
import { MapControls } from './components/MapControls';
import { StyleSwitch } from './components/StyleSwitch';
import { Legend } from './components/Legend';
import { Timeline } from './components/Timeline';
import { DetailPanel } from './components/DetailPanel';
import { ChatDrawer } from './components/ChatDrawer';
import { Toasts } from './components/Toasts';
import { Banners } from './components/Banners';
import { AboutDialog } from './components/AboutDialog';
import { LoadingVeil } from './components/LoadingVeil';
import { ReplayBar } from './components/ReplayBar';
import { startData } from './state/data';
import { restoreHashSelection, startHashSync } from './state/urlState';
import { bindKeyboard } from './state/keyboard';
import { useStore } from './state/store';

export function App() {
  useEffect(() => {
    startData();
    restoreHashSelection();
    startHashSync();
    return bindKeyboard();
  }, []);

  const panelOpen = useStore((s) => !!s.selection);
  const chatOpen = useStore((s) => s.chatOpen);

  return (
    <div className={`app${panelOpen ? ' has-panel' : ''}${chatOpen ? ' has-chat' : ''}`}>
      <MapView />
      <ERCV6Panel />
      <TopBar />
      <Banners />
      <MapControls />
      <StyleSwitch />
      <Legend />
      <Timeline />
      <ReplayBar />
      <DetailPanel />
      <ChatDrawer />
      <Toasts />
      <AboutDialog />
      <LoadingVeil />
    </div>
  );
}
