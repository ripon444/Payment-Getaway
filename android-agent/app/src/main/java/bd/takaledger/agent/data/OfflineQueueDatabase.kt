package bd.takaledger.agent.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase

@Entity(
    tableName = "queued_notifications",
    indices = [Index(value = ["eventHash"], unique = true)]
)
data class QueuedNotificationEntity(
    @PrimaryKey val eventUid: String,
    val eventHash: String,
    val sourceChannel: String = "NOTIFICATION",
    val packageName: String,
    val senderHeader: String? = null,
    val simSlot: Int? = null,
    val title: String?,
    val bodyRedacted: String,
    val deviceTimestampMs: Long,
    val attemptCount: Int = 0,
    val lastError: String? = null,
    val synced: Boolean = false,
    val createdAtMs: Long = System.currentTimeMillis()
)

@Dao
interface QueuedNotificationDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun enqueueIfNew(entity: QueuedNotificationEntity): Long

    @Query("SELECT * FROM queued_notifications WHERE synced = 0 ORDER BY deviceTimestampMs ASC LIMIT :limit")
    suspend fun getPendingBatch(limit: Int = 50): List<QueuedNotificationEntity>

    @Query("SELECT COUNT(*) FROM queued_notifications WHERE synced = 0")
    suspend fun getPendingCount(): Int

    @Query("UPDATE queued_notifications SET synced = 1 WHERE eventUid IN (:uids)")
    suspend fun markSynced(uids: List<String>)

    @Query("UPDATE queued_notifications SET attemptCount = attemptCount + 1, lastError = :error WHERE eventUid IN (:uids)")
    suspend fun recordFailure(uids: List<String>, error: String)

    @Query("DELETE FROM queued_notifications WHERE synced = 1 AND createdAtMs < :cutoffMs")
    suspend fun pruneSyncedOlderThan(cutoffMs: Long)
}

@Database(entities = [QueuedNotificationEntity::class], version = 2, exportSchema = false)
abstract class OfflineQueueDatabase : RoomDatabase() {
    abstract fun dao(): QueuedNotificationDao

    companion object {
        @Volatile
        private var INSTANCE: OfflineQueueDatabase? = null

        fun getInstance(context: Context): OfflineQueueDatabase {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: Room.databaseBuilder(
                    context.applicationContext,
                    OfflineQueueDatabase::class.java,
                    "takaledger_offline_queue.db"
                ).fallbackToDestructiveMigration().build().also { INSTANCE = it }
            }
        }
    }
}
