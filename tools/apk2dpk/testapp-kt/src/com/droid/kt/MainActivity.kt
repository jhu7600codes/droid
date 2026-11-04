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
import java.util.concurrent.Executors
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

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
        // threads: a producer / consumer pair over a blocking queue, wait / notify, a spinning thread,
        // an executor future, and a latch; the result comes back to the ui thread
        (findViewById(R.id.threads) as Button).setOnClickListener {
            val info = findViewById(R.id.info) as TextView
            info.text = "threads running..."
            Thread {
                val q = LinkedBlockingQueue<Int>(4)
                val producer = Thread { for (i in 1..20) q.put(i); q.put(-1) }
                producer.start()
                var sum = 0
                while (true) { val x = q.take(); if (x < 0) break; sum += x }
                producer.join()
                val lock = Object()
                var ready = false
                val waiter = Thread { synchronized(lock) { while (!ready) lock.wait(); } }
                waiter.start()
                Thread.sleep(50)
                synchronized(lock) { ready = true; lock.notifyAll() }
                waiter.join(2000)
                val spins = longArrayOf(0)
                val spinner = Thread { val end = System.currentTimeMillis() + 300; while (System.currentTimeMillis() < end) spins[0]++ }
                spinner.start()
                val pool = Executors.newSingleThreadExecutor()
                val f = pool.submit<Int> { (1..10).map { it * it }.sum() }
                val latch = CountDownLatch(3)
                repeat(3) { Thread { Thread.sleep(20); latch.countDown() }.start() }
                val ok = latch.await(2, TimeUnit.SECONDS)
                spinner.join()
                val squares = f.get()
                pool.shutdown()
                val text = "threads ok: queue sum $sum, waiter done ${!waiter.isAlive}, latch $ok, squares $squares, spins ${if (spins[0] > 0) "yes" else "no"}"
                runOnUiThread { info.text = text }
            }.start()
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
