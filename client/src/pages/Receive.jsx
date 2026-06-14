import { useParams } from 'react-router-dom';
import Shell from '../components/Shell.jsx';
import ReceivePanel from '../components/ReceivePanel.jsx';

// The key lives in the URL fragment (after '#'), which the browser never sends
// to any server. We read it here on the client and hand it to the receiver.
function readKeyFromHash() {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash.replace(/^#/, '');
  return new URLSearchParams(hash).get('k');
}

export default function Receive() {
  const { roomId } = useParams();
  const keyStr = readKeyFromHash();

  return (
    <Shell>
      <ReceivePanel roomId={roomId} keyStr={keyStr} />
    </Shell>
  );
}
