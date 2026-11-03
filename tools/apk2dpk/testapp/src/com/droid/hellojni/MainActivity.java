package com.droid.hellojni;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.util.Log;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.ListView;
import android.widget.TextView;
import android.widget.Toast;
import java.util.ArrayList;

// an old style activity: no support library, java only, plus a jni library (armeabi-v7a)
public class MainActivity extends Activity {
    static { System.loadLibrary("hello"); }

    public native String stringFromJNI();
    public native int add(int a, int b);
    public native long fib(int n);

    private int count;
    private final ArrayList<String> items = new ArrayList<String>();
    private ArrayAdapter<String> adapter;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setContentView(R.layout.main);
        final TextView text = (TextView) findViewById(R.id.text);
        final EditText name = (EditText) findViewById(R.id.name);
        final CheckBox check = (CheckBox) findViewById(R.id.check);
        SharedPreferences prefs = getSharedPreferences("hello", MODE_PRIVATE);
        count = saved != null ? saved.getInt("count", 0) : prefs.getInt("count", 0);
        text.setText(stringFromJNI() + "\n2 + 3 = " + add(2, 3) + ", fib(40) = " + fib(40) + "\njava: " + javaWork());
        adapter = new ArrayAdapter<String>(this, android.R.layout.simple_list_item_1, items);
        ((ListView) findViewById(R.id.list)).setAdapter(adapter);

        ((Button) findViewById(R.id.button)).setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                count++;
                int shown = check.isChecked() ? add(count, 0) : count;
                String who = name.getText().toString().trim();
                StringBuilder sb = new StringBuilder(getString(R.string.clicked));
                sb.append(' ').append(shown);
                if (who.length() > 0) sb.append(", hi ").append(who);
                items.add(0, sb.toString());
                adapter.notifyDataSetChanged();
                Toast.makeText(MainActivity.this, "click " + count, Toast.LENGTH_SHORT).show();
                Log.d("HelloJNI", "clicked " + count);
                getSharedPreferences("hello", MODE_PRIVATE).edit().putInt("count", count).commit();
            }
        });
        ((Button) findViewById(R.id.open)).setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                Intent i = new Intent(MainActivity.this, SecondActivity.class);
                i.putExtra("count", count);
                startActivity(i);
            }
        });
    }

    // plain java: loops, longs, doubles, arrays, exceptions
    private String javaWork() {
        long sum = 0;
        int[] squares = new int[20];
        for (int i = 0; i < squares.length; i++) { squares[i] = i * i; sum += squares[i]; }
        double avg = sum / (double) squares.length;
        String caught = "none";
        try { Object o = null; o.toString(); } catch (NullPointerException e) { caught = "npe"; }
        try { int z = squares.length - 20; int bad = 10 / z; caught += bad; } catch (ArithmeticException e) { caught += "+div0"; }
        return "sum " + sum + ", avg " + avg + ", " + caught + ", max " + Math.max(7, 42) + ", " + Integer.toHexString(48879);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        out.putInt("count", count);
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, 1, 0, "Reset");
        menu.add(0, 2, 0, "About");
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == 1) { count = 0; items.clear(); adapter.notifyDataSetChanged(); }
        else Toast.makeText(this, "Hello JNI 1.2, converted by droid", Toast.LENGTH_LONG).show();
        return true;
    }
}
