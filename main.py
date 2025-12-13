from flask import Flask, jsonify, request, send_from_directory
from flask_socketio import SocketIO, emit
from TikTokLive import TikTokLiveClient
from TikTokLive.events import CommentEvent, GiftEvent, LikeEvent, JoinEvent, ConnectEvent, DisconnectEvent
import asyncio
import threading
import json
from database import init_db
from manager import manager

# Initialize DB
init_db()

app = Flask(__name__, static_folder='public')
# Use threading mode to avoid conflict with asyncio
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# Global map [sid] -> {'client': client, 'loop': loop, 'thread': thread}
clients = {}

@app.route('/')
def index():
    return send_from_directory('public', 'index.html')

@app.route('/<path:path>')
def static_files(path):
    return send_from_directory('public', path)

# API Routes
@app.route('/api/price', methods=['POST'])
def update_price():
    data = request.json
    manager.save_price(data['id'], float(data['price']))
    return jsonify({'success': True})

@app.route('/api/rooms', methods=['POST'])
def save_room():
    data = request.json
    room = manager.update_room(data['roomId'], data.get('name'), data.get('address'))
    return jsonify({'success': True, 'room': {'room_id': room.room_id, 'name': room.name}})

@app.route('/api/rooms', methods=['GET'])
def get_rooms():
    return jsonify(manager.get_rooms())

@app.route('/api/sessions/end', methods=['POST'])
def end_session_api():
    data = request.json
    session_id = manager.create_session(data['roomId'], data['snapshot'])
    return jsonify({'success': True, 'sessionId': session_id})

@app.route('/api/sessions', methods=['GET'])
def list_sessions():
    room_id = request.args.get('roomId')
    sessions = manager.get_sessions(room_id)
    return jsonify(sessions)

@app.route('/api/sessions/<session_id>', methods=['GET'])
def load_session(session_id):
    data = manager.get_session(session_id)
    if data:
        return jsonify(data)
    return jsonify({'error': 'Not found'}), 404

@app.route('/api/history', methods=['GET'])
def get_history():
    room_id = request.args.get('roomId')
    stats = manager.get_time_stats(room_id)
    return jsonify(stats)

# Helper to run async client in thread
def run_client_async(sid, unique_id, options):
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    
    # Filter options
    if 'enableExtendedGiftInfo' in options: del options['enableExtendedGiftInfo']

    try:
        client = None
    if unique_id.isdigit():
        print(f"Connecting via Room ID: {unique_id}")
        client = TikTokLiveClient(unique_id="unknown", room_id=unique_id, **options)
    else:
        client = TikTokLiveClient(unique_id=unique_id, **options)
        
        # Store client ref
        if sid in clients:
            clients[sid]['client'] = client
            clients[sid]['loop'] = loop

        # Bind events
        @client.on(ConnectEvent)
        async def on_connect(e: ConnectEvent):
            socketio.emit('tiktokConnected', {'currentState': 'CONNECTED'}, room=sid)

        @client.on(DisconnectEvent)
        async def on_disconnect(e: DisconnectEvent):
            socketio.emit('tiktokDisconnected', str(e), room=sid)

        @client.on(CommentEvent)
        async def on_chat(event: CommentEvent):
            data = {
                'uniqueId': event.user.unique_id,
                'nickname': event.user.nickname,
                'comment': event.comment,
                'userId': event.user.user_id,
                'region': event.user.region, 
            }
            socketio.emit('chat', data, room=sid)
            manager.log_event(client.room_id, 'chat', data)

        @client.on(GiftEvent)
        async def on_gift(event: GiftEvent):
            data = {
                'uniqueId': event.user.unique_id,
                'nickname': event.user.nickname,
                'userId': event.user.user_id,
                'region': event.user.region,
                'giftId': event.gift.gift_id,
                'giftName': event.gift.extended_gift.name if event.gift.extended_gift else "Unknown",
                'repeatCount': 1, 
                'giftType': event.gift.gift_type,
                'diamondCount': event.gift.extended_gift.diamond_count if event.gift.extended_gift else 0
            }
            socketio.emit('gift', data, room=sid)
            manager.log_event(client.room_id, 'gift', data)

        @client.on(LikeEvent)
        async def on_like(event: LikeEvent):
            data = {
                'uniqueId': event.user.unique_id,
                'nickname': event.user.nickname,
                'userId': event.user.user_id,
                'likeCount': event.count,
                'totalLikeCount': event.total_likes
            }
            socketio.emit('like', data, room=sid)
            manager.log_event(client.room_id, 'like', data)
        
        @client.on(JoinEvent)
        async def on_member(event: JoinEvent):
            data = {
                'uniqueId': event.user.unique_id,
                'nickname': event.user.nickname
            }
            socketio.emit('member', data, room=sid)

        loop.run_until_complete(client.start())
    except Exception as e:
        print(f"Client Loop Error: {e}")
        import traceback
        traceback.print_exc()
        socketio.emit('tiktokDisconnected', f"Error: {e}", room=sid)
    finally:
        loop.close()
        # Ensure client knows we stopped
        socketio.emit('tiktokDisconnected', "Connection Closed", room=sid)

# SocketIO Events
@socketio.on('setUniqueId')
def set_unique_id(unique_id, options={}):
    sid = request.sid
    print(f"Client {sid} connecting to {unique_id}")
    
    # Cleanup existing
    if sid in clients:
        try:
            # Stop the loop/client?
            # Accessing loop from another thread is disallowed usually.
            # Best way is to just let it die or explicit cancel.
            # Since we overwrite, let's just null stats. 
            pass 
        except:
            pass
            
    clients[sid] = {}
    
    # Start thread
    t = threading.Thread(target=run_client_async, args=(sid, unique_id, options))
    t.daemon = True
    t.start()
    clients[sid]['thread'] = t

@socketio.on('disconnect')
def on_disconnect():
    sid = request.sid
    if sid in clients:
        # We can't easily kill the thread/loop from here safely without complex signaling.
        # But it will die if the main process dies or eventually if we implement stop logic.
        del clients[sid]

if __name__ == '__main__':
    # Threading mode is required for this approach
    socketio.run(app, host='0.0.0.0', port=5000)
