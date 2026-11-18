# TakaLedger Agent Release ProGuard / R8 Rules

# Keep Room Database, Entities, and generated _Impl classes
-keep class * extends androidx.room.RoomDatabase
-keep @androidx.room.Entity class *
-dontwarn androidx.room.paging.**

# Keep WorkManager Workers invoked via reflection
-keepclassmembers class * extends androidx.work.ListenableWorker {
    public <init>(android.content.Context, androidx.work.WorkerParameters);
}

# Keep Service, BroadcastReceiver, and Launcher Activity entry points
-keep class bd.takaledger.agent.service.MfsNotificationListenerService { *; }
-keep class bd.takaledger.agent.service.MfsSmsReceiver { *; }
-keep class bd.takaledger.agent.ui.PairingActivity { *; }
-keep class bd.takaledger.agent.worker.EventSyncWorker { *; }

# Keep OkHttp / Okio / Security Crypto rules cleanly without warnings
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn javax.annotation.**
-keepclassmembers class * extends com.google.crypto.tink.** { *; }
