package com.droid.kt

import android.app.Activity
import android.app.AlarmManager
import android.content.BroadcastReceiver
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.MediaPlayer
import android.os.Bundle
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.ListView
import android.widget.TextView
import android.widget.Toast

data class Pigeon(val name: String, val age: Int) {
    fun describe() = "$name ($age)"
}

object Flock {
    val names = listOf("Gray", "Blue", "Danen", "Pip", "Coo")
    fun next(n: Int) = Pigeon(names[n % names.size], n % 7 + 1)
}

fun Int.squared() = this * this

class MainActivity : Activity() {
    private lateinit var adapter: ArrayAdapter<String>
    private val pigeons = mutableListOf<Pigeon>()
    private var player: MediaPlayer? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.main)
        val nums = (1..10).toList()
        val evens = nums.filter { it % 2 == 0 }.map { it.squared() }
        val total = evens.sum()
        val label: String? = intent?.getStringExtra("label")
        val kind = when {
            total > 200 -> "big"
            total > 100 -> "medium"
            else -> "small"
        }
        (findViewById(R.id.info) as TextView).text = "kotlin on droid\nevens squared: ${evens.joinToString()}\nsum $total is $kind, label ${label ?: "none"}\n${Pigeon("Gray", 3)}"
        adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, mutableListOf<String>())
        (findViewById(R.id.list) as ListView).adapter = adapter
        (findViewById(R.id.add) as Button).setOnClickListener {
            val p = Flock.next(pigeons.size)
            pigeons += p
            adapter.add(p.describe())
            Toast.makeText(this, "${pigeons.size} pigeons, oldest ${pigeons.maxByOrNull { it.age }?.name}", Toast.LENGTH_SHORT).show()
        }
        (findViewById(R.id.notify) as Button).setOnClickListener {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java).putExtra("label", "from the notification"), 0)
            val n = Notification.Builder(this)
                .setContentTitle("${pigeons.size} pigeons in the flock")
                .setContentText("tap to open the kotlin test")
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentIntent(open)
                .setAutoCancel(true)
                .build()
            nm.notify(1, n)
        }
        (findViewById(R.id.notify) as Button).setOnLongClickListener {
            val am = getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val pi = PendingIntent.getBroadcast(this, 7, Intent(this, Reminder::class.java).putExtra("count", pigeons.size), 0)
            am.set(AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + 10000, pi)
            Toast.makeText(this, "reminder in 10 seconds", Toast.LENGTH_SHORT).show()
            true
        }
        (findViewById(R.id.play) as Button).setOnClickListener {
            player?.release()
            player = MediaPlayer.create(this, R.raw.beep).apply {
                setOnCompletionListener { Toast.makeText(this@MainActivity, "sound done", Toast.LENGTH_SHORT).show() }
                start()
            }
        }
    }

    override fun onPause() {
        super.onPause()
        player?.pause()
    }
}

class Reminder : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val count = intent.getIntExtra("count", 0)
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val open = PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java).putExtra("label", "from the reminder"), 0)
        val n = Notification.Builder(context)
            .setTicker("pigeon reminder: $count in the flock")
            .setContentTitle("pigeon reminder")
            .setContentText("$count pigeons are waiting")
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        nm.notify(2, n)
    }
}
